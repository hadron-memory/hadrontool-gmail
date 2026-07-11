import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { encryptToken, decryptToken } from '../crypto.js';
import { db } from '../db.js';
import { hashInput } from '../ops/index.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

/** Seed one ACTIVE connection and return its id. */
async function seedConnection(refreshToken = 'rt-original'): Promise<string> {
  const row = await db.connection.create({
    data: { mailboxEmail: 'prof@example.edu', refreshTokenEnc: encryptToken(refreshToken) },
  });
  return row.id;
}

beforeEach(() => resetDb(db));

describe('POST /ops/:operation', () => {
  it('rejects calls without the bearer token', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/list-messages').send({ connectionId: 'c' });
    expect(res.status).toBe(401);
  });

  it('404s an unknown operation, listing the known ones', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/read-minds').set(AUTH).send({});
    expect(res.status).toBe(404);
    expect(res.body.operations).toContain('list-messages');
  });

  it('returns connection_not_found for an unknown connectionId', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('connection_not_found');
  });

  it('lists messages in the neutral shape, decrypting the stored token', async () => {
    const connectionId = await seedConnection('rt-original');
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId, unreadOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({
      id: 'msg-1',
      conversationId: 'conv-1',
      from: { address: 'student@example.edu' },
      snippet: 'When are your office hours?',
      isRead: false, // derived from the UNREAD label
    });
    // The DECRYPTED token reached the provider, with the unread option intact.
    const [method, args] = provider.calls[0];
    expect(method).toBe('listMessages');
    expect(args[0]).toBe('rt-original');
    expect(args[1]).toBe('inbox');
    expect(args[2]).toMatchObject({ unreadOnly: true });
  });

  it('persists a rotated refresh token', async () => {
    const connectionId = await seedConnection('rt-original');
    const app = createApp(db, fakeProvider({ rotateTo: 'rt-rotated' }), async () => {});

    await request(app).post('/ops/get-message').set(AUTH).send({ connectionId, messageId: 'm-1' }).expect(200);

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-rotated');
  });

  it('creates a reply draft via save-draft { replyToMessageId }', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post('/ops/save-draft')
      .set(AUTH)
      .send({ connectionId, replyToMessageId: 'msg-1', bodyHtml: '<p>Tuesdays 2–4pm.</p>' });
    expect(res.status).toBe(200);
    expect(res.body.draftId).toBe('draft-reply');
    expect(res.body.conversationId).toBe('conv-1');
    expect(provider.calls[0][0]).toBe('createDraftReply');
  });

  it('requires recipients + subject on a fresh draft', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider(), async () => {});

    const noTo = await request(app).post('/ops/save-draft').set(AUTH).send({ connectionId, bodyHtml: '<p>x</p>' });
    expect(noTo.status).toBe(400);
    expect(noTo.body.error).toBe('recipients_required');

    const empty = await request(app)
      .post('/ops/save-draft')
      .set(AUTH)
      .send({ connectionId, to: ['a@b.c'], subject: 's', bodyHtml: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('body_required');
  });

  it("rejects the neutral 'complete' flag state — Gmail's star is binary", async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post('/ops/flag-message')
      .set(AUTH)
      .send({ connectionId, messageId: 'm-1', flag: 'complete' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('flag');
    expect(provider.calls.filter(([m]) => m === 'flagMessage')).toHaveLength(0);
  });

  it("maps 'flagged' / 'none' onto the star", async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    await request(app).post('/ops/flag-message').set(AUTH).send({ connectionId, messageId: 'm-1', flag: 'flagged' }).expect(200);
    await request(app).post('/ops/flag-message').set(AUTH).send({ connectionId, messageId: 'm-1', flag: 'none' }).expect(200);
    const flags = provider.calls.filter(([m]) => m === 'flagMessage').map(([, args]) => args[2]);
    expect(flags).toEqual(['flagged', 'none']);
  });

  it('replays a mutating operation with the same idempotencyKey without touching the provider', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const body = { connectionId, messageId: 'msg-1', bodyHtml: '<p>ok</p>', idempotencyKey: 'key-1' };
    const first = await request(app).post('/ops/reply-to-message').set(AUTH).send(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ sent: true, replayed: false });

    const second = await request(app).post('/ops/reply-to-message').set(AUTH).send(body);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ sent: true, replayed: true });

    expect(provider.calls.filter(([m]) => m === 'replyToMessage')).toHaveLength(1);
  });

  it('rejects reusing an idempotencyKey across operations', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider(), async () => {});

    await request(app)
      .post('/ops/reply-to-message')
      .set(AUTH)
      .send({ connectionId, messageId: 'm', bodyHtml: 'x', idempotencyKey: 'shared' })
      .expect(200);
    const res = await request(app)
      .post('/ops/send-draft')
      .set(AUTH)
      .send({ connectionId, draftId: 'd', idempotencyKey: 'shared' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('persists a rotated refresh token even when the API call fails', async () => {
    const connectionId = await seedConnection('rt-original');
    // The real client attaches newRefreshToken to the thrown error when the
    // refresh succeeded before the API call failed — the fake simulates that.
    const app = createApp(
      db,
      fakeProvider({ failWith: { methods: ['getMessage'], error: { statusCode: 404, newRefreshToken: 'rt-rotated-on-failure' } } }),
      async () => {},
    );

    const res = await request(app).post('/ops/get-message').set(AUTH).send({ connectionId, messageId: 'gone' });
    expect(res.status).toBe(404);

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-rotated-on-failure');
  });

  it('rejects an idempotencyKey replayed with a different payload', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider(), async () => {});

    await request(app)
      .post('/ops/reply-to-message')
      .set(AUTH)
      .send({ connectionId, messageId: 'm-1', bodyHtml: '<p>A</p>', idempotencyKey: 'key-p' })
      .expect(200);
    const res = await request(app)
      .post('/ops/reply-to-message')
      .set(AUTH)
      .send({ connectionId, messageId: 'm-1', bodyHtml: '<p>B — different!</p>', idempotencyKey: 'key-p' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects a key whose original request is still in flight (no double execution)', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    // Simulate an in-flight original: a reservation row with no response yet.
    await db.idempotencyRecord.create({
      data: { key: 'key-inflight', operation: 'send-draft', requestHash: 'someone-elses-hash', responseJson: null },
    });
    const res = await request(app)
      .post('/ops/send-draft')
      .set(AUTH)
      .send({ connectionId, draftId: 'd-1', idempotencyKey: 'key-inflight' });
    expect(res.status).toBe(400);
    expect(provider.calls.filter(([m]) => m === 'sendDraft')).toHaveLength(0);
  });

  it('reclaims a stale orphaned reservation (crashed process) so a retry executes', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    // A reservation from a request whose process died mid-flight, past the
    // staleness cutoff — the retry (same payload, same hash) must execute,
    // not wait for the 7-day prune.
    await db.idempotencyRecord.create({
      data: {
        key: 'key-orphan',
        operation: 'send-draft',
        requestHash: hashInput({ connectionId, draftId: 'd-1' }),
        responseJson: null,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    const res = await request(app)
      .post('/ops/send-draft')
      .set(AUTH)
      .send({ connectionId, draftId: 'd-1', idempotencyKey: 'key-orphan' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, replayed: false });
    expect(provider.calls.filter(([m]) => m === 'sendDraft')).toHaveLength(1);
  });

  it('releases the reservation when the operation fails so a retry can execute', async () => {
    const connectionId = await seedConnection();
    const failing = createApp(
      db,
      fakeProvider({ failWith: { methods: ['sendDraft'], error: { statusCode: 503 } } }),
      async () => {},
    );
    await request(failing)
      .post('/ops/send-draft')
      .set(AUTH)
      .send({ connectionId, draftId: 'd-1', idempotencyKey: 'key-retry' })
      .expect(502);

    const working = createApp(db, fakeProvider(), async () => {});
    const res = await request(working)
      .post('/ops/send-draft')
      .set(AUTH)
      .send({ connectionId, draftId: 'd-1', idempotencyKey: 'key-retry' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, replayed: false });
  });

  it('maps provider auth failure to connection_unauthorized and marks the connection ERROR', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider({ failWith: { methods: ['getMessage'], error: { statusCode: 401 } } }), async () => {});

    const res = await request(app).post('/ops/get-message').set(AUTH).send({ connectionId, messageId: 'm-1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('connection_unauthorized');

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.status).toBe('ERROR');

    // Subsequent calls short-circuit on the stored ERROR status.
    const again = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId });
    expect(again.status).toBe(403);
  });

  it('surfaces provider rate limiting as provider_rate_limited (Google 403 quota flavor)', async () => {
    const connectionId = await seedConnection();
    const app = createApp(
      db,
      fakeProvider({ failWith: { methods: ['listMessages'], error: { statusCode: 403, reason: 'rateLimitExceeded' } } }),
      async () => {},
    );
    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'provider_rate_limited', retryAfterSeconds: 60 });
  });

  it('validates input via zod → validation_error', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId, top: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('top');
  });
});
