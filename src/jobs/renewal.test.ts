import { beforeEach, describe, expect, it } from 'vitest';
import { pruneLedgers, renewExpiringWatches, sweepHistory } from './renewal.js';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import type { EmailEvent } from '../events/forwarder.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

/** Seed a connection with a watch expiring in `hours` hours. */
async function seed(hours: number, status: 'ACTIVE' | 'ERROR' = 'ACTIVE', lastHistoryId: string | null = '100') {
  const connection = await db.connection.create({
    data: { mailboxEmail: `m${hours}@x.y`, refreshTokenEnc: encryptToken('rt'), status },
  });
  const watch = await db.watch.create({
    data: {
      connectionId: connection.id,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
      lastHistoryId,
    },
  });
  await db.subscribedFolder.create({ data: { connectionId: connection.id, folder: 'inbox' } });
  return { connection, watch };
}

beforeEach(() => resetDb(db));

describe('renewExpiringWatches', () => {
  it('re-watches only watches inside the 24h lookahead window', async () => {
    const { connection: soon, watch: soonWatch } = await seed(2);
    await seed(72); // far in the future — untouched
    const provider = fakeProvider();

    await renewExpiringWatches(db, provider);

    const watchCalls = provider.calls.filter(([m]) => m === 'createWatch');
    expect(watchCalls).toHaveLength(1);

    const row = await db.watch.findUniqueOrThrow({ where: { connectionId: soon.id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(soonWatch.expiresAt.getTime());
  });

  it('preserves the history cursor on re-watch (never fast-forwards)', async () => {
    const { connection } = await seed(1, 'ACTIVE', '250');
    const provider = fakeProvider({ watchHistoryId: '900' });

    await renewExpiringWatches(db, provider);

    const row = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(row.lastHistoryId).toBe('250');
  });

  it('skips connections in ERROR status', async () => {
    await seed(1, 'ERROR');
    const provider = fakeProvider();
    await renewExpiringWatches(db, provider);
    expect(provider.calls).toHaveLength(0);
  });

  it('marks the connection ERROR and does not churn when the grant is dead', async () => {
    const { connection } = await seed(1);
    const provider = fakeProvider({ failWith: { methods: ['createWatch'], error: { statusCode: 401 } } });

    await renewExpiringWatches(db, provider);

    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.status).toBe('ERROR');
  });

  it('does not let one undecryptable token abort the pass for other watches', async () => {
    const bad = await seed(1);
    await db.connection.update({
      where: { id: bad.connection.id },
      data: { refreshTokenEnc: 'not-valid-ciphertext' },
    });
    await seed(2);
    const provider = fakeProvider();

    await renewExpiringWatches(db, provider);

    // The good connection's watch was still re-registered.
    expect(provider.calls.filter(([m]) => m === 'createWatch')).toHaveLength(1);
  });
});

describe('sweepHistory', () => {
  it('processes pending deltas for active watches (recovers events lost to a failed push pass)', async () => {
    const { connection } = await seed(100, 'ACTIVE', '100');
    const events: EmailEvent[] = [];
    const provider = fakeProvider({
      historyDelta: { historyId: '200', messagesAdded: [{ id: 'msg-lost', threadId: null, labelIds: ['INBOX'] }] },
    });

    await sweepHistory(db, provider, async (e) => {
      events.push(e);
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'email.received', connectionId: connection.id });
    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('200');
  });

  it('skips watches without a cursor and connections in ERROR', async () => {
    await seed(100, 'ACTIVE', null);
    await seed(101, 'ERROR', '100');
    const provider = fakeProvider();

    await sweepHistory(db, provider, async () => {});

    expect(provider.calls.filter(([m]) => m === 'listHistory')).toHaveLength(0);
  });
});

describe('pruneLedgers', () => {
  it('prunes dedupe + idempotency rows past the retention window, keeping fresh ones', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.processedNotification.create({ data: { id: 'old:1', processedAt: old } });
    await db.processedNotification.create({ data: { id: 'fresh:1' } });
    await db.idempotencyRecord.create({
      data: { key: 'old-key', operation: 'send-draft', requestHash: 'h', responseJson: '{}', createdAt: old },
    });
    await db.idempotencyRecord.create({
      data: { key: 'fresh-key', operation: 'send-draft', requestHash: 'h', responseJson: '{}' },
    });

    await pruneLedgers(db);

    expect(await db.processedNotification.count()).toBe(1);
    expect(await db.idempotencyRecord.count()).toBe(1);
    expect(await db.processedNotification.findUnique({ where: { id: 'fresh:1' } })).toBeTruthy();
    expect(await db.idempotencyRecord.findUnique({ where: { key: 'fresh-key' } })).toBeTruthy();
  });
});
