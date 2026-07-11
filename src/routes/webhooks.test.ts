import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import type { EmailEvent } from '../events/forwarder.js';
import { fakeProvider, resetDb, type FakeProviderOptions } from '../test/fakes.js';

const PUSH_PATH = '/webhooks/gmail?token=test-pubsub-token';

/** Seed a connection + watch (+ subscribed folders); returns the connection. */
async function seedWatchedConnection(folders: string[] = ['inbox'], lastHistoryId: string | null = '100') {
  const connection = await db.connection.create({
    data: { mailboxEmail: 'prof@example.edu', refreshTokenEnc: encryptToken('rt-1') },
  });
  await db.watch.create({
    data: { connectionId: connection.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), lastHistoryId },
  });
  for (const folder of folders) {
    await db.subscribedFolder.create({ data: { connectionId: connection.id, folder } });
  }
  return connection;
}

/** A Pub/Sub push envelope for a Gmail notification. */
function pushBody(emailAddress = 'prof@example.edu', historyId: string | number = '150') {
  return {
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64'),
      messageId: 'pubsub-msg-1',
    },
    subscription: 'projects/test-project/subscriptions/gmail-push',
  };
}

/** Build an app collecting forwarded events over a fake provider. */
function appWithEvents(options: FakeProviderOptions = {}) {
  const events: EmailEvent[] = [];
  const provider = fakeProvider(options);
  const app = createApp(db, provider, async (e) => {
    events.push(e);
  });
  return { app, events, provider };
}

/** Await the fire-and-forget notification processing. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => resetDb(db));

describe('POST /webhooks/gmail', () => {
  it('rejects pushes without the verification token (no processing)', async () => {
    await seedWatchedConnection();
    const { app, events, provider } = appWithEvents();

    await request(app).post('/webhooks/gmail').send(pushBody()).expect(403);
    await request(app).post('/webhooks/gmail?token=wrong').send(pushBody()).expect(403);
    await settle();

    expect(events).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('processes a history delta and forwards an inbox message as email.received', async () => {
    const connection = await seedWatchedConnection(['inbox'], '100');
    const { app, events, provider } = appWithEvents({
      historyDelta: {
        historyId: '200',
        messagesAdded: [{ id: 'msg-77', threadId: 't-77', labelIds: ['INBOX', 'UNREAD'] }],
      },
    });

    await request(app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'email.received',
      connectionId: connection.id,
      folder: 'inbox',
      message: { id: 'msg-77', from: { address: 'student@example.edu' } },
    });
    // The delta started from the stored cursor, and advanced it.
    const historyCall = provider.calls.find(([m]) => m === 'listHistory')!;
    expect(historyCall[1][1]).toBe('100');
    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('200');
  });

  it('labels SENT messages email.sent (SENT beats INBOX for self-addressed mail)', async () => {
    await seedWatchedConnection(['inbox', 'sentitems'], '100');
    const { app, events } = appWithEvents({
      historyDelta: {
        historyId: '200',
        messagesAdded: [{ id: 'msg-88', threadId: null, labelIds: ['SENT', 'INBOX'] }],
      },
    });

    await request(app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('email.sent');
    expect(events[0].folder).toBe('sentitems');
  });

  it('skips unsubscribed folders and drafts, still advancing the cursor', async () => {
    const connection = await seedWatchedConnection(['inbox'], '100'); // sentitems NOT subscribed
    const { app, events, provider } = appWithEvents({
      historyDelta: {
        historyId: '300',
        messagesAdded: [
          { id: 'msg-sent', threadId: null, labelIds: ['SENT'] },
          { id: 'msg-draft', threadId: null, labelIds: ['DRAFT'] },
          { id: 'msg-archived', threadId: null, labelIds: ['IMPORTANT'] },
        ],
      },
    });

    await request(app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();

    expect(events).toHaveLength(0);
    expect(provider.calls.filter(([m]) => m === 'getMessage')).toHaveLength(0);
    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('300');
  });

  it('dedupes messages across overlapping deltas (at-least-once → forwarded once)', async () => {
    await seedWatchedConnection(['inbox'], '100');
    const { app, events } = appWithEvents({
      historyDelta: {
        historyId: '200',
        messagesAdded: [{ id: 'msg-77', threadId: null, labelIds: ['INBOX'] }],
      },
    });

    await request(app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();
    // Reset the cursor to simulate the next delta overlapping the same message.
    await db.watch.updateMany({ data: { lastHistoryId: '100' } });
    await request(app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();

    expect(events).toHaveLength(1);
  });

  it('releases the dedupe row and holds the cursor back on processing failure, so a retry succeeds', async () => {
    const connection = await seedWatchedConnection(['inbox'], '100');
    const delta = {
      historyId: '200',
      messagesAdded: [{ id: 'msg-77', threadId: null, labelIds: ['INBOX'] }],
    };

    // First delivery: transient failure fetching the message.
    const failing = appWithEvents({
      historyDelta: delta,
      failWith: { methods: ['getMessage'], error: { statusCode: 503 } },
    });
    await request(failing.app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();
    expect(failing.events).toHaveLength(0);
    expect(await db.processedNotification.count()).toBe(0); // released
    const held = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(held.lastHistoryId).toBe('100'); // NOT advanced

    // The next notification retries the same delta; a healthy pass processes it.
    const working = appWithEvents({ historyDelta: delta });
    await request(working.app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();
    expect(working.events).toHaveLength(1);
    const advanced = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(advanced.lastHistoryId).toBe('200');
  });

  it('treats a message that vanished before processing as handled (cursor advances)', async () => {
    const connection = await seedWatchedConnection(['inbox'], '100');
    const { app, events } = appWithEvents({
      historyDelta: {
        historyId: '200',
        messagesAdded: [{ id: 'msg-gone', threadId: null, labelIds: ['INBOX'] }],
      },
      failWith: { methods: ['getMessage'], error: { statusCode: 404 } },
    });

    await request(app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();

    expect(events).toHaveLength(0);
    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('200'); // permanent skip, not a retry loop
  });

  it('re-baselines an expired history cursor instead of looping on 404', async () => {
    const connection = await seedWatchedConnection(['inbox'], '100');
    const { app, events } = appWithEvents({
      failWith: { methods: ['listHistory'], error: { statusCode: 404 } },
      currentHistoryId: '9000',
    });

    await request(app).post(PUSH_PATH).send(pushBody()).expect(204);
    await settle();

    expect(events).toHaveLength(0);
    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('9000');
  });

  it('adopts the notified historyId when the cursor was never set (no delta run)', async () => {
    const connection = await seedWatchedConnection(['inbox'], null);
    const { app, provider } = appWithEvents();

    await request(app).post(PUSH_PATH).send(pushBody('prof@example.edu', 12345)).expect(204);
    await settle();

    expect(provider.calls.filter(([m]) => m === 'listHistory')).toHaveLength(0);
    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('12345'); // numeric payloads normalize to string
  });

  it('acks and drops malformed envelopes and unknown mailboxes', async () => {
    await seedWatchedConnection();
    const { app, events, provider } = appWithEvents();

    await request(app).post(PUSH_PATH).send({ nonsense: true }).expect(204);
    await request(app).post(PUSH_PATH).send({ message: { data: 'not-base64-json!' } }).expect(204);
    await request(app).post(PUSH_PATH).send(pushBody('stranger@example.edu')).expect(204);
    await settle();

    expect(events).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });
});
