import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { decryptToken, encryptToken } from '../crypto.js';
import { db } from '../db.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

beforeEach(() => resetDb(db));

describe('/connections', () => {
  it('creates a connection from an OAuth code, using ID-token claims first', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ code: 'auth-code-1', redirectUri: 'https://core.example/auth/gmail/callback' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      provider: 'gmail',
      mailboxEmail: 'user@gmail.example',
      displayName: 'Gmail User',
      status: 'ACTIVE',
    });
    // The exchange used core's redirect URI (must match the authorize URL).
    expect(provider.calls[0]).toEqual(['exchangeCode', ['auth-code-1', 'https://core.example/auth/gmail/callback']]);
    // ID-token claims sufficed — no userinfo round-trip.
    expect(provider.calls.some(([m]) => m === 'fetchProfile')).toBe(false);

    // The refresh token is stored ENCRYPTED, decryptable with the tool key.
    const row = await db.connection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.refreshTokenEnc).not.toContain('rt-fresh');
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-fresh');
  });

  it('falls back to the userinfo endpoint when the ID token lacks claims', async () => {
    const provider = fakeProvider({ omitIdToken: true });
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ code: 'auth-code-1', redirectUri: 'https://core.example/cb' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mailboxEmail: 'userinfo@gmail.example', displayName: 'Userinfo User' });
    expect(provider.calls.some(([m]) => m === 'fetchProfile')).toBe(true);
  });

  it('returns a typed error when Google omits the refresh token (offline access not granted)', async () => {
    const app = createApp(db, fakeProvider({ omitRefreshToken: true }), async () => {});
    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ code: 'auth-code-1', redirectUri: 'https://core.example/cb' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.reason).toContain('access_type=offline');
    expect(await db.connection.count()).toBe(0);
  });

  it('rejects a create without a code', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/connections').set(AUTH).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('returns identity + subscription state on GET, and 404s a deleted connection', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const app = createApp(db, fakeProvider(), async () => {});

    const res = await request(app).get(`/connections/${connection.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mailboxEmail: 'a@b.c', subscriptions: [] });
    // The encrypted token never leaves the tool.
    expect(JSON.stringify(res.body)).not.toContain('refreshToken');

    await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
    await request(app).get(`/connections/${connection.id}`).set(AUTH).expect(404);
  });

  it('registers the mailbox watch when subscribing a folder', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const provider = fakeProvider({ watchHistoryId: '4321' });
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post(`/connections/${connection.id}/subscriptions`)
      .set(AUTH)
      .send({ folder: 'Inbox' }); // case-insensitive
    expect(res.status).toBe(201);
    expect(res.body.folder).toBe('inbox');

    const [method, args] = provider.calls.find(([m]) => m === 'createWatch')!;
    expect(method).toBe('createWatch');
    expect(args[1]).toBe('projects/test-project/topics/gmail-push'); // PUBSUB_TOPIC

    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('4321'); // the watch baseline seeds the cursor
    const folder = await db.subscribedFolder.findUniqueOrThrow({
      where: { connectionId_folder: { connectionId: connection.id, folder: 'inbox' } },
    });
    expect(folder).toBeTruthy();
  });

  it('re-subscribing re-watches but does NOT fast-forward a live history cursor', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const app1 = createApp(db, fakeProvider({ watchHistoryId: '100' }), async () => {});
    await request(app1).post(`/connections/${connection.id}/subscriptions`).set(AUTH).send({ folder: 'inbox' }).expect(201);

    // Some deltas were processed since; the cursor moved on.
    await db.watch.update({ where: { connectionId: connection.id }, data: { lastHistoryId: '250' } });

    const app2 = createApp(db, fakeProvider({ watchHistoryId: '900' }), async () => {});
    await request(app2).post(`/connections/${connection.id}/subscriptions`).set(AUTH).send({ folder: 'sentitems' }).expect(201);

    const watch = await db.watch.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(watch.lastHistoryId).toBe('250'); // NOT 900 — fast-forwarding would drop 250→900
  });

  it('rejects unsupported folders', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app)
      .post(`/connections/${connection.id}/subscriptions`)
      .set(AUTH)
      .send({ folder: 'junkemail' });
    expect(res.status).toBe(400);
  });

  it('stops the watch then soft-deletes the connection', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    await db.watch.create({
      data: { connectionId: connection.id, expiresAt: new Date(Date.now() + 1000 * 60), lastHistoryId: '1' },
    });
    await db.subscribedFolder.create({ data: { connectionId: connection.id, folder: 'inbox' } });
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    await request(app).delete(`/connections/${connection.id}`).set(AUTH).expect(200);

    expect(provider.calls.some(([m]) => m === 'stopWatch')).toBe(true);
    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await db.watch.count({ where: { connectionId: connection.id } })).toBe(0);
    expect(await db.subscribedFolder.count({ where: { connectionId: connection.id } })).toBe(0);
  });

  it('does NOT stop the account-wide watch while a sibling connection for the same mailbox exists', async () => {
    // users.stop is mailbox-level: disconnecting org A's connection must not
    // kill org B's push feed (or the new connection minted by a reconnect).
    const orgA = await db.connection.create({
      data: { mailboxEmail: 'shared@gmail.example', refreshTokenEnc: encryptToken('rt-a') },
    });
    const orgB = await db.connection.create({
      data: { mailboxEmail: 'shared@gmail.example', refreshTokenEnc: encryptToken('rt-b') },
    });
    await db.watch.create({
      data: { connectionId: orgA.id, expiresAt: new Date(Date.now() + 1000 * 60), lastHistoryId: '1' },
    });
    await db.watch.create({
      data: { connectionId: orgB.id, expiresAt: new Date(Date.now() + 1000 * 60), lastHistoryId: '1' },
    });
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    await request(app).delete(`/connections/${orgA.id}`).set(AUTH).expect(200);

    expect(provider.calls.some(([m]) => m === 'stopWatch')).toBe(false);
    expect(await db.watch.count({ where: { connectionId: orgA.id } })).toBe(0);
    expect(await db.watch.count({ where: { connectionId: orgB.id } })).toBe(1);

    // The LAST connection for the mailbox does stop the watch.
    await request(app).delete(`/connections/${orgB.id}`).set(AUTH).expect(200);
    expect(provider.calls.some(([m]) => m === 'stopWatch')).toBe(true);
  });

  it('still disconnects when the provider stop-watch call fails', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    await db.watch.create({
      data: { connectionId: connection.id, expiresAt: new Date(Date.now() + 1000 * 60), lastHistoryId: '1' },
    });
    const app = createApp(db, fakeProvider({ failWith: { methods: ['stopWatch'], error: { statusCode: 503 } } }), async () => {});

    await request(app).delete(`/connections/${connection.id}`).set(AUTH).expect(200);
    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.deletedAt).not.toBeNull();
  });
});
