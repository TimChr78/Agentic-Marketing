import { randomBytes } from 'node:crypto';
import { sha256 } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { localKeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import type { EgressPolicy, SafeResponse } from '../src/egress';
import { type OAuthDeps, type OAuthRequest, oauthRoutes, refreshConnection } from '../src/oauth';

// #375 and #376: the OAuth code exchange runs outside the app transaction, and a rotating refresh
// token is redeemed by one replica at a time. The fake provider is deterministic, delayed and
// rotating; no real provider or network is involved.

const kp = localKeyProvider(Buffer.alloc(32, 7).toString('base64'));
const EGRESS: EgressPolicy = { allowedHosts: [] };
const STATE_HASH = (state: string) => sha256(`oauth-state:${state}`);

const TOKEN_URL = 'https://provider.example.com/oauth/token';
const SETTINGS = {
  baseUrl: 'https://api.provider.example.com',
  authorizeUrl: 'https://provider.example.com/oauth/authorize',
  tokenUrl: TOKEN_URL,
  scopes: ['read'],
  authorizeParams: {},
};

const response = (body: unknown, status = 200): SafeResponse => ({ status, headers: {}, body: JSON.stringify(body) });
const connectionId = () => `con_${randomBytes(16).toString('hex')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Db proxy that counts how many workspace transactions are open at once. */
function tracked(db: Db) {
  let open = 0;
  let peak = 0;
  const proxy = {
    ...db,
    withWorkspace: async <T>(workspaceId: string, fn: (tx: never) => Promise<T>, opts?: { snapshot?: boolean }) => {
      open++;
      peak = Math.max(peak, open);
      try {
        return await db.withWorkspace(workspaceId, fn as never, opts);
      } finally {
        open--;
      }
    },
  } as Db;
  return { db: proxy, open: () => open, peak: () => peak };
}

let t: DisposableDb;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  t = await createDisposableDb('oauth');
}, 120_000);

afterAll(async () => {
  if (t) await t.close();
});

async function addConnection(
  opts: { id?: string; access?: string; refresh?: string; expiresAt?: Date | null; pending?: { state?: string } } = {},
) {
  const id = opts.id ?? connectionId();
  const sealed = await t.db.withWorkspace(t.workspace, (tx) =>
    sealJson(tx, t.workspace, kp, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      __oauth: {
        ...(opts.access ? { accessToken: opts.access } : {}),
        ...(opts.refresh ? { refreshToken: opts.refresh } : {}),
      },
    }),
  );
  const pending = opts.pending
    ? {
        stateHash: STATE_HASH(opts.pending.state!),
        verifier: 'verifier',
        redirectUri: 'https://admin.example.com/oauth/callback',
        at: new Date().toISOString(),
      }
    : null;
  await t.db.admin.query(
    `INSERT INTO connections
       (workspace_id, id, connector, name, settings, secrets, secrets_key_id, oauth_status, oauth_pending, token_expires_at, enabled)
     VALUES ($1, $2, 'oauth_http', 'Provider', $3, $4, $5, $6, $7, $8, true)`,
    [
      t.workspace,
      id,
      JSON.stringify(SETTINGS),
      sealed.blob,
      sealed.keyId,
      opts.pending ? 'pending' : 'connected',
      pending,
      opts.expiresAt === undefined ? new Date(Date.now() + 60 * 60_000) : opts.expiresAt,
    ],
  );
  return id;
}

const secretsOf = async (id: string) => {
  const { rows } = await t.db.admin.query<{ secrets: Buffer; secrets_key_id: string }>(
    'SELECT secrets, secrets_key_id FROM connections WHERE workspace_id = $1 AND id = $2',
    [t.workspace, id],
  );
  const row = rows[0]!;
  return t.db.withWorkspace(t.workspace, (tx) => openJson<Record<string, any>>(tx, t.workspace, kp, row.secrets, row.secrets_key_id));
};

const connectionOf = async (id: string) => {
  const { rows } = await t.db.admin.query<{
    oauth_status: string;
    oauth_error: string | null;
    oauth_pending: Record<string, unknown> | null;
    token_expires_at: Date | null;
    oauth_refresh_lease_until: Date | null;
    oauth_refresh_lease_token: string | null;
    enabled: boolean;
  }>(
    `SELECT oauth_status, oauth_error, oauth_pending, token_expires_at,
            oauth_refresh_lease_until, oauth_refresh_lease_token, enabled
       FROM connections WHERE workspace_id = $1 AND id = $2`,
    [t.workspace, id],
  );
  return rows[0]!;
};

const callback = (app: ReturnType<typeof oauthRoutes>, state: string, extra = '&code=code-1') =>
  app.request(`https://admin.example.com/oauth/callback?state=${encodeURIComponent(state)}${extra}`);

describe.skipIf(!hasTestDatabase())('OAuth callback (#375)', () => {
  it('exchanges the code with no transaction open, then persists the tokens', async () => {
    const state = randomBytes(12).toString('base64url');
    const id = await addConnection({ pending: { state } });
    const tracker = tracked(t.db);
    let seenOpen = -1;
    const http: OAuthRequest = async () => {
      seenOpen = tracker.open();
      await sleep(20);
      return response({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, token_type: 'Bearer' });
    };
    const deps: OAuthDeps = { db: tracker.db, kp, egress: EGRESS, http };
    const res = await callback(oauthRoutes(deps), state);
    expect(res.status).toBe(200);
    expect(seenOpen).toBe(0);
    expect(await connectionOf(id)).toMatchObject({ oauth_status: 'connected', oauth_pending: null });
    expect((await secretsOf(id)).__oauth).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2' });
  });

  it('consumes the state once, so a replay cannot exchange a second code', async () => {
    const state = randomBytes(12).toString('base64url');
    await addConnection({ pending: { state } });
    let calls = 0;
    const http: OAuthRequest = async () => {
      calls++;
      return response({ access_token: 'AT2', expires_in: 3600 });
    };
    const app = oauthRoutes({ db: t.db, kp, egress: EGRESS, http });
    expect((await callback(app, state)).status).toBe(200);
    const replay = await callback(app, state);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('expired');
    expect(calls).toBe(1);
  });

  it('does not overwrite a newer authorization that started while the exchange was in flight', async () => {
    const state = randomBytes(12).toString('base64url');
    const newer = randomBytes(12).toString('base64url');
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', pending: { state } });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    const http: OAuthRequest = async () => {
      started();
      await gate;
      return response({ access_token: 'STALE', refresh_token: 'STALE-RT', expires_in: 3600 });
    };
    const result = callback(oauthRoutes({ db: t.db, kp, egress: EGRESS, http }), state);
    await inFlight;
    // A second "Connect" replaced the pending authorization while the first code was exchanged.
    await t.db.admin.query(
      `UPDATE connections SET oauth_pending = jsonb_build_object(
         'stateHash', $3::text, 'verifier', 'v2',
         'redirectUri', 'https://admin.example.com/oauth/callback', 'at', now()::text)
       WHERE workspace_id = $1 AND id = $2`,
      [t.workspace, id, STATE_HASH(newer)],
    );
    release();
    const res = await result;
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('newer authorization');
    expect((await secretsOf(id)).__oauth).toMatchObject({ accessToken: 'AT1', refreshToken: 'RT1' });
    expect((await connectionOf(id)).oauth_pending).toMatchObject({ stateHash: STATE_HASH(newer) });
  });

  it('does not store tokens on a connection disabled during the exchange', async () => {
    const state = randomBytes(12).toString('base64url');
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', pending: { state } });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    const http: OAuthRequest = async () => {
      started();
      await gate;
      return response({ access_token: 'STALE', expires_in: 3600 });
    };
    const result = callback(oauthRoutes({ db: t.db, kp, egress: EGRESS, http }), state);
    await inFlight;
    await t.db.admin.query('UPDATE connections SET enabled = false WHERE workspace_id = $1 AND id = $2', [t.workspace, id]);
    release();
    const res = await result;
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('deleted or disabled');
    expect((await secretsOf(id)).__oauth).toMatchObject({ accessToken: 'AT1' });
  });

  it('marks an expired or refused exchange as an error without holding the pool', async () => {
    const state = randomBytes(12).toString('base64url');
    const id = await addConnection({ pending: { state } });
    const tracker = tracked(t.db);
    const http: OAuthRequest = async () => {
      expect(tracker.open()).toBe(0);
      await sleep(10);
      throw new Error('provider said no');
    };
    const res = await callback(oauthRoutes({ db: tracker.db, kp, egress: EGRESS, http }), state);
    expect(res.status).toBe(400);
    expect(await connectionOf(id)).toMatchObject({ oauth_status: 'error', oauth_pending: null });
  });

  it('keeps the provider’s OAuth error code but never its description’s credential (#885 round 2)', async () => {
    const state = randomBytes(12).toString('base64url');
    const id = await addConnection({ pending: { state } });
    const http: OAuthRequest = async () => response({ error: 'invalid_grant', error_description: 'password=probe-secret' }, 400);
    const res = await callback(oauthRoutes({ db: t.db, kp, egress: EGRESS, http }), state);
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain('invalid_grant');
    expect(page).not.toContain('probe-secret');
    expect((await connectionOf(id)).oauth_error).toContain('invalid_grant');
    expect((await connectionOf(id)).oauth_error).not.toContain('probe-secret');
  });

  it('redacts a multi-line provider description before keeping its first line (#885 round 3)', async () => {
    const state = randomBytes(12).toString('base64url');
    const id = await addConnection({ pending: { state } });
    const http: OAuthRequest = async () => response({ error: 'invalid_grant', error_description: 'password="probe-secret\nrest"' }, 400);
    const res = await callback(oauthRoutes({ db: t.db, kp, egress: EGRESS, http }), state);
    expect(await res.text()).not.toContain('probe-secret');
    expect((await connectionOf(id)).oauth_error).not.toContain('probe-secret');
  });

  it('redacts an OAuth description whose credential starts with a scheme word (#885 round 3)', async () => {
    const state = randomBytes(12).toString('base64url');
    const id = await addConnection({ pending: { state } });
    const http: OAuthRequest = async () => response({ error: 'invalid_grant', error_description: 'token=Bearer-probe-secret' }, 400);
    const res = await callback(oauthRoutes({ db: t.db, kp, egress: EGRESS, http }), state);
    expect(await res.text()).not.toContain('probe-secret');
    expect((await connectionOf(id)).oauth_error).not.toContain('probe-secret');
  });

  it('does not quote a transport failure from the token endpoint (#885 round 2)', async () => {
    const state = randomBytes(12).toString('base64url');
    const id = await addConnection({ pending: { state } });
    const http: OAuthRequest = async () => {
      throw new Error('driver failure: password=probe-secret');
    };
    const res = await callback(oauthRoutes({ db: t.db, kp, egress: EGRESS, http }), state);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('probe-secret');
    expect((await connectionOf(id)).oauth_error).not.toContain('probe-secret');
  });

  it('keeps unrelated workspace transactions available while many exchanges wait', async () => {
    const connections = await Promise.all(
      Array.from({ length: 6 }, () => {
        const state = randomBytes(12).toString('base64url');
        return addConnection({ pending: { state } }).then((id) => ({ id, state }));
      }),
    );
    let started = 0;
    let openAll!: () => void;
    const allStarted = new Promise<void>((r) => {
      openAll = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const http: OAuthRequest = async () => {
      started++;
      if (started === connections.length) openAll();
      await gate;
      return response({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
    };
    const app = oauthRoutes({ db: t.db, kp, egress: EGRESS, http });
    const calls = connections.map(({ state }) => callback(app, state));
    await allStarted;
    // With the app pool capped at two, this probe would stall for the whole exchange if the
    // callbacks held a transaction across HTTP.
    const began = Date.now();
    await t.db.withWorkspace(t.workspace, (tx) => tx.execute(sql`SELECT 1`));
    const probeMs = Date.now() - began;
    release();
    const responses = await Promise.all(calls);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(probeMs).toBeLessThan(1_000);
    for (const { id } of connections) expect(await connectionOf(id)).toMatchObject({ oauth_status: 'connected' });
  });
});

describe.skipIf(!hasTestDatabase())('OAuth refresh serialization (#376)', () => {
  it('lets one of two concurrent refreshes redeem a rotating token and stores its result', async () => {
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', expiresAt: new Date(Date.now() - 1_000) });
    let posts = 0;
    const http: OAuthRequest = async () => {
      posts++;
      await sleep(60);
      return response({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
    };
    const deps: OAuthDeps = { db: t.db, kp, egress: EGRESS, http };
    await Promise.all([refreshConnection(t.db, t.workspace, id, deps), refreshConnection(t.db, t.workspace, id, deps)]);
    expect(posts).toBe(1);
    expect(await connectionOf(id)).toMatchObject({
      oauth_status: 'connected',
      oauth_refresh_lease_until: null,
      oauth_refresh_lease_token: null,
    });
    expect((await secretsOf(id)).__oauth).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2' });
  });

  it('skips a refresh another replica completed after the scheduler selected the row', async () => {
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', expiresAt: new Date(Date.now() - 1_000) });
    const http: OAuthRequest = async () => {
      throw new Error('must not be called');
    };
    // Another replica refreshed and stored a fresh expiry just before this claim.
    await t.db.admin.query('UPDATE connections SET token_expires_at = $3 WHERE workspace_id = $1 AND id = $2', [
      t.workspace,
      id,
      new Date(Date.now() + 60 * 60_000),
    ]);
    await refreshConnection(t.db, t.workspace, id, { db: t.db, kp, egress: EGRESS, http });
    expect(await connectionOf(id)).toMatchObject({ oauth_status: 'connected', oauth_refresh_lease_token: null });
    expect((await secretsOf(id)).__oauth).toMatchObject({ accessToken: 'AT1' });
  });

  it('does not brick a newer valid authorization with a stale invalid_grant', async () => {
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', expiresAt: new Date(Date.now() - 1_000) });
    const http: OAuthRequest = async () => {
      const sealed = await t.db.withWorkspace(t.workspace, (tx) =>
        sealJson(tx, t.workspace, kp, {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          __oauth: { accessToken: 'AT2', refreshToken: 'RT2' },
        }),
      );
      // The winner (or a re-authorization) stored a newer authorization while we were on the wire.
      await t.db.admin.query(
        'UPDATE connections SET secrets = $3, secrets_key_id = $4, oauth_status = $5, token_expires_at = $6 WHERE workspace_id = $1 AND id = $2',
        [t.workspace, id, sealed.blob, sealed.keyId, 'connected', new Date(Date.now() + 60 * 60_000)],
      );
      throw Object.assign(new Error('invalid grant'), { code: 'invalid_grant' });
    };
    await refreshConnection(t.db, t.workspace, id, { db: t.db, kp, egress: EGRESS, http });
    const row = await connectionOf(id);
    expect(row).toMatchObject({ oauth_status: 'connected', oauth_error: null, oauth_refresh_lease_token: null });
    expect((await secretsOf(id)).__oauth).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2' });
  });

  it('marks a genuinely refused refresh token as an error and releases the lease', async () => {
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', expiresAt: new Date(Date.now() - 1_000) });
    const http: OAuthRequest = async () => {
      throw Object.assign(new Error('invalid grant'), { code: 'invalid_grant' });
    };
    await refreshConnection(t.db, t.workspace, id, { db: t.db, kp, egress: EGRESS, http });
    const row = await connectionOf(id);
    expect(row).toMatchObject({ oauth_status: 'error', oauth_refresh_lease_until: null, oauth_refresh_lease_token: null });
    expect(row.oauth_error).toContain('connect again');
  });

  it('keeps invalid_grant but redacts the provider description on a refused refresh (#885 round 2)', async () => {
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', expiresAt: new Date(Date.now() - 1_000) });
    const http: OAuthRequest = async () => response({ error: 'invalid_grant', error_description: 'password=probe-secret' }, 400);
    await refreshConnection(t.db, t.workspace, id, { db: t.db, kp, egress: EGRESS, http });
    const row = await connectionOf(id);
    expect(row).toMatchObject({ oauth_status: 'error' });
    expect(row.oauth_error).toContain('invalid_grant');
    expect(row.oauth_error).not.toContain('probe-secret');
  });

  it('writes a fixed text when a refresh fails unexpectedly (#885 round 2)', async () => {
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', expiresAt: new Date(Date.now() - 1_000) });
    const http: OAuthRequest = async () => {
      throw Object.assign(new Error('driver failure: password=probe-secret'), { code: 'invalid_grant' });
    };
    await refreshConnection(t.db, t.workspace, id, { db: t.db, kp, egress: EGRESS, http });
    const row = await connectionOf(id);
    expect(row).toMatchObject({ oauth_status: 'error' });
    expect(row.oauth_error).not.toContain('probe-secret');
    expect(row.oauth_error).not.toContain('driver failure');
  });

  it('retries after a transient refresh failure instead of marking the connection broken', async () => {
    const id = await addConnection({ access: 'AT1', refresh: 'RT1', expiresAt: new Date(Date.now() - 1_000) });
    const http: OAuthRequest = async () => {
      throw new Error('temporary network error');
    };
    await refreshConnection(t.db, t.workspace, id, { db: t.db, kp, egress: EGRESS, http });
    expect(await connectionOf(id)).toMatchObject({ oauth_status: 'connected', oauth_refresh_lease_until: null });
    expect((await secretsOf(id)).__oauth).toMatchObject({ accessToken: 'AT1', refreshToken: 'RT1' });
  });
});
