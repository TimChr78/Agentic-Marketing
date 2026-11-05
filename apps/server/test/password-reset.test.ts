import { getEventListeners } from 'node:events';
import { hashedResetTokenIdentifier, RESET_PASSWORD_TTL_SECONDS } from '@agentic-marketing/auth';
import type { Db } from '@agentic-marketing/db';
import { outbox } from '@agentic-marketing/email';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { passwordResetRoutes } from '../src/http/password-reset';
import {
  enqueueResetRequest,
  openResetEmail,
  openResetToken,
  runPasswordResetDeliveries,
  runPasswordResetDeliveriesOnce,
  sendPasswordResetEmail,
} from '../src/passwordReset';
import { cookieOf, startTestServer, testPort, type User } from './harness';

// Self-service password reset (#191): the neutral answer, the mailed link, the password change,
// single use and expiry, session revocation, the rate limits, single sign-on people and the audit.
// #379: the request path is account-agnostic (seal + enqueue); the worker does account lookup,
// eligibility, token minting and delivery with a fenced lease.

const PORT = testPort(2600);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-brand-new-staple-42';
const MAIL_SUBJECT = 'Reset your Agentic Marketing password';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

/** A distinct client IP per call, so one test's rate-limit buckets never touch another's (or an earlier run's). */
const nextIp = () => `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
const runId = Math.random().toString(36).slice(2, 8);

const headers = (ip: string) => ({ 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': ip });

const forgot = (email: string, ip = nextIp()) =>
  fetch(`${BASE}/api/auth/forgot-password`, { method: 'POST', headers: headers(ip), body: JSON.stringify({ email }) });

const reset = (token: string, newPassword: string, ip = nextIp()) =>
  fetch(`${BASE}/api/auth/reset-password`, {
    method: 'POST',
    headers: headers(ip),
    body: JSON.stringify({ token, newPassword }),
  });

const signIn = (email: string, password: string) =>
  fetch(`${BASE}/api/auth/sign-in/email`, { method: 'POST', headers: headers(nextIp()), body: JSON.stringify({ email, password }) });

const mailsTo = (email: string) => outbox.filter((m) => m.to === email && m.subject === MAIL_SUBJECT);

/** The test server runs the reset worker on an all-but-infinite tick; drive one round here. */
const deliver = (send?: Parameters<typeof runPasswordResetDeliveriesOnce>[0]['send'], opts: { batch?: number; cleanup?: boolean } = {}) =>
  runPasswordResetDeliveriesOnce(
    {
      db: t.srv.db,
      kp: t.srv.keyProvider,
      email: t.srv.email,
      directory: t.srv.directory,
      publicUrl: t.base,
      ttlSeconds: RESET_PASSWORD_TTL_SECONDS,
      secret: t.srv.authSecret,
      auth: t.srv.auth,
      ...(send ? { send } : {}),
    },
    opts,
  );

interface QueueRow {
  id: string;
  email_sealed: Buffer | null;
  ip: string;
  user_id: string | null;
  token_sealed: Buffer | null;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';
  outcome: string | null;
  attempts: number;
  claim_id: string | null;
  next_attempt_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const allRows = async () => (await t.srv.db.admin.query<QueueRow>('SELECT * FROM password_reset_deliveries ORDER BY created_at')).rows;
const queueRows = async (userId: string) =>
  (await t.srv.db.admin.query<QueueRow>('SELECT * FROM password_reset_deliveries WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
const queuedRows = async () =>
  (
    await t.srv.db.admin.query<QueueRow>(
      `SELECT * FROM password_reset_deliveries WHERE status IN ('queued', 'sending') ORDER BY created_at`,
    )
  ).rows;
const rowFor = async (email: string) =>
  (await queuedRows()).find((row) => row.email_sealed && openResetEmail(t.srv.authSecret, row.email_sealed) === email);
const verificationRows = async (userId: string) =>
  (
    await t.srv.db.admin.query<{ identifier: string; value: string; expiresAt: Date }>(
      'SELECT identifier, value, "expiresAt" FROM "verification" WHERE value = $1',
      [userId],
    )
  ).rows;
const auditRows = async (userId: string) =>
  (
    await t.srv.db.admin.query<{ ok: boolean; error: string | null; ip: string | null }>(
      `SELECT ok, error, ip FROM audit_log WHERE principal_id = $1 AND command = 'auth.passwordResetRequest' ORDER BY seq`,
      [userId],
    )
  ).rows;

/** A request plus the delivery round it queued (the response itself never sends). */
async function requestLink(email: string, ip = nextIp()) {
  const res = await forgot(email, ip);
  await deliver();
  return res;
}

/** The token in the one link the reset mail carries. */
function linkToken(mail: { text: string }): string {
  const url = /https?:\/\/\S+/.exec(mail.text)?.[0];
  const token = url ? new URL(url).searchParams.get('token') : null;
  if (!token) throw new Error(`the reset mail has no token in its link: ${mail.text}`);
  return token;
}

async function newAccountAt(email: string): Promise<User> {
  const u = await t.signUp(email);
  await t.srv.db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'marketer')`, [ws, u.id]);
  return u;
}

async function newAccount(): Promise<User> {
  return newAccountAt(`reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`);
}

/** The sender the second test creates; a test that needs mail on its own creates one if absent. */
async function ensureTransactionalProvider() {
  const { rows } = await t.srv.db.admin.query<{ n: string }>('SELECT count(*) AS n FROM email_providers WHERE enabled');
  if (Number(rows[0]?.n ?? 0) > 0) return;
  await t.api(owner, ws).call('emailProviders.create', {
    name: 'Security mail',
    adapter: 'log',
    fromEmail: 'security@example.com',
    useFor: ['transactional'],
  });
}

beforeAll(async () => {
  // The test client connects over loopback and passes a distinct x-forwarded-for per call, so the
  // loopback peer must be a trusted proxy for the per-IP buckets (#378 made the default ignore it).
  t = await startTestServer('test_pwreset', PORT, { TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128' });
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 90_000);
afterAll(() => t?.close());
beforeEach(async () => {
  outbox.length = 0;
  // Start every test with no leftover queued rows or mail, so delivery summaries are exact.
  await deliver();
  outbox.length = 0;
});

describe('requesting a reset link (#191)', () => {
  it('answers neutrally and warns when no transactional sender is configured', async () => {
    const res = await forgot(owner.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: true,
      message: 'If an account exists for that address, we sent a link to reset the password.',
    });
    // The request itself only queues a sealed address; the worker discovers the missing sender.
    const queued = await rowFor(owner.email);
    expect(queued).toMatchObject({ status: 'queued', attempts: 0, user_id: null, token_sealed: null });
    expect(await verificationRows(owner.id)).toHaveLength(0);
    expect(mailsTo(owner.email)).toHaveLength(0);

    const summary = await deliver();
    expect(summary).toMatchObject({ handled: 1, sent: 0, failed: 1, skipped: 0 });
    const [row] = await queueRows(owner.id);
    expect(row).toMatchObject({ status: 'failed', outcome: 'no_sender', email_sealed: null, token_sealed: null });
    expect(mailsTo(owner.email)).toHaveLength(0);
  });

  it('answers the same for a known and an unknown address, and only the known one gets mail', async () => {
    await t.api(owner, ws).call('emailProviders.create', {
      name: 'Security mail',
      adapter: 'log',
      fromEmail: 'security@example.com',
      useFor: ['transactional'],
    });
    const known = await newAccount();
    const unknown = `nobody-${runId}@example.com`;
    const knownRes = await forgot(known.email);
    const unknownRes = await forgot(unknown);
    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    expect(await unknownRes.json()).toEqual(await knownRes.json());

    // Both requests did exactly the same work: one sealed row, no account id, no token, no mail.
    const knownRow = await rowFor(known.email);
    const unknownRow = await rowFor(unknown);
    expect(knownRow).toMatchObject({ status: 'queued', attempts: 0, user_id: null, token_sealed: null });
    expect(unknownRow).toMatchObject({ status: 'queued', attempts: 0, user_id: null, token_sealed: null });
    expect(await verificationRows(known.id)).toHaveLength(0);
    expect(mailsTo(known.email)).toHaveLength(0);
    expect(mailsTo(unknown)).toHaveLength(0);

    const summary = await deliver();
    expect(summary).toMatchObject({ handled: 2, sent: 1, failed: 0, skipped: 1 });
    expect(mailsTo(known.email)).toHaveLength(1);
    expect(mailsTo(unknown)).toHaveLength(0);
    expect((await queueRows(known.id))[0]).toMatchObject({ status: 'sent', outcome: 'sent', email_sealed: null, token_sealed: null });
    const unknownAfter = (await allRows()).find((row) => row.id === unknownRow?.id);
    expect(unknownAfter).toMatchObject({ status: 'skipped', outcome: 'unknown', email_sealed: null, token_sealed: null });
  });

  it('mails a single-use link to PUBLIC_URL that sets the new password', async () => {
    const account = await newAccount();
    expect((await requestLink(account.email)).status).toBe(200);
    const mail = mailsTo(account.email)[0];
    expect(mail).toBeTruthy();
    expect(mail.from.email).toBe('security@example.com');
    expect(mail.text).toContain(`${BASE}/reset-password?token=`);
    expect(mail.html).toContain(`${BASE}/reset-password?token=`);
    // No tracking pixel, and the sender is the workspace's provider, not a brand guess.
    expect(mail.html).not.toMatch(/<img/i);
    const token = linkToken(mail);

    // The token is stored hashed: a dump of the table never yields a usable link.
    const rows = await verificationRows(account.id);
    expect(rows.map((r) => r.identifier)).toContain(hashedResetTokenIdentifier(token));
    expect(rows.some((r) => r.identifier.includes(token))).toBe(false);

    const res = await reset(token, NEW_PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: true });

    const oldSignIn = await signIn(account.email, PASSWORD);
    expect(oldSignIn.status).toBe(401);
    const newSignIn = await signIn(account.email, NEW_PASSWORD);
    expect(newSignIn.status).toBe(200);
    expect(cookieOf(newSignIn)).toBeTruthy();

    // Single use: the same link cannot set another password.
    const again = await reset(token, 'yet-another-password-9');
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('refuses an expired token with the same clear error', async () => {
    const account = await newAccount();
    await requestLink(account.email);
    const token = linkToken(mailsTo(account.email)[0]);
    await t.srv.db.admin.query(`UPDATE "verification" SET "expiresAt" = now() - interval '1 minute' WHERE identifier = $1`, [
      hashedResetTokenIdentifier(token),
    ]);
    const res = await reset(token, NEW_PASSWORD);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('not valid any more');
  });

  it('refuses a malformed token', async () => {
    const res = await reset('not-a-real-token', NEW_PASSWORD);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('revokes the other sessions of that person', async () => {
    const account = await newAccount();
    const first = await signIn(account.email, PASSWORD);
    const second = await signIn(account.email, PASSWORD);
    const sessionOf = async (cookie: string) =>
      (await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie } })).json() as Promise<{ user?: { id: string } } | null>;
    expect((await sessionOf(cookieOf(first)))?.user?.id).toBe(account.id);
    expect((await sessionOf(cookieOf(second)))?.user?.id).toBe(account.id);

    await requestLink(account.email);
    expect((await reset(linkToken(mailsTo(account.email)[0]), NEW_PASSWORD)).status).toBe(200);

    expect(await sessionOf(cookieOf(first))).toBeNull();
    expect(await sessionOf(cookieOf(second))).toBeNull();
  });

  it('does not mail a person who signs in with single sign-on only', async () => {
    const account = await newAccount();
    // What an SSO/SCIM-provisioned person looks like: an account with no password credential.
    await t.srv.db.admin.query(`DELETE FROM "account" WHERE "userId" = $1`, [account.id]);
    const res = await requestLink(account.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: true });
    expect(mailsTo(account.email)).toHaveLength(0);
    // The request was queued uniformly; the worker terminalizes it as no_password.
    expect((await queueRows(account.id))[0]).toMatchObject({
      status: 'skipped',
      outcome: 'no_password',
      email_sealed: null,
      token_sealed: null,
    });
    expect((await auditRows(account.id)).at(-1)?.error).toContain('no_password');
  });

  it('does not send a second link inside the cooldown', async () => {
    const account = await newAccount();
    await forgot(account.email);
    await forgot(account.email);
    // Only the first request queued a row; the cooldown answer is neutral but does no work.
    expect(await queuedRows()).toHaveLength(1);
    await deliver();
    expect(mailsTo(account.email)).toHaveLength(1);
  });

  it('sends one installation-level link to a person in two brands, from the workspace they joined first', async () => {
    const account = await newAccount();
    // A second workspace with its own transactional sender, joined later.
    const second = await t.workspaceWith([
      [owner, 'owner'],
      [account, 'marketer'],
    ]);
    await t.api(owner, second).call('emailProviders.create', {
      name: 'Other brand',
      adapter: 'log',
      fromEmail: 'other@example.com',
      useFor: ['transactional'],
    });
    // The membership in `ws` (from newAccount) is the older one; make that certain.
    await t.srv.db.admin.query(
      `UPDATE workspace_members SET created_at = now() - interval '1 hour' WHERE workspace_id = $1 AND user_id = $2`,
      [ws, account.id],
    );

    expect((await requestLink(account.email)).status).toBe(200);
    const mails = mailsTo(account.email);
    expect(mails).toHaveLength(1);
    // `ws` carries the sender created earlier in this file.
    expect(mails[0].from.email).toBe('security@example.com');
  });

  it('rate limits per address across IPs', async () => {
    const account = await newAccount();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await forgot(account.email)).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    const limited = await forgot(account.email);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('rate limits per IP and recovers on another address', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await forgot(`flood-${runId}-${i}@example.com`, ip)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    const limited = await forgot(`flood-again-${runId}@example.com`, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    // A different client is not affected.
    expect((await forgot(`flood-elsewhere-${runId}@example.com`)).status).toBe(200);
  });
});

describe('the answer does not depend on the account (#379)', () => {
  it('returns before a slow provider runs, and the worker delivers the link afterwards', async () => {
    await ensureTransactionalProvider();
    const account = await newAccount();

    const started = Date.now();
    const res = await forgot(account.email);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    // Nothing has been mailed yet: the request only queued a sealed address.
    expect(mailsTo(account.email)).toHaveLength(0);
    expect(await rowFor(account.email)).toMatchObject({ status: 'queued', attempts: 0, user_id: null, token_sealed: null });

    const calls: string[] = [];
    const slowSender = async (
      deps: Parameters<typeof sendPasswordResetEmail>[0],
      person: Parameters<typeof sendPasswordResetEmail>[1],
      token: string,
      ttl: number,
    ) => {
      calls.push(person.id);
      // A provider that takes 1.5 seconds: the HTTP response above must not have waited for this.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return sendPasswordResetEmail(deps, person, token, ttl);
    };
    const workerStarted = Date.now();
    const summary = await deliver(slowSender);
    expect(Date.now() - workerStarted).toBeGreaterThanOrEqual(1400);
    expect(summary).toMatchObject({ handled: 1, sent: 1 });
    expect(calls).toEqual([account.id]);
    expect(mailsTo(account.email)).toHaveLength(1);
    expect((await queueRows(account.id))[0]).toMatchObject({ status: 'sent', token_sealed: null });
  }, 30_000);

  it('queues the same sealed row for known, unknown and single sign-on addresses before any account lookup', async () => {
    await ensureTransactionalProvider();
    const known = await newAccount();
    const unknown = `uniform-unknown-${runId}@example.com`;
    const sso = await newAccount();
    await t.srv.db.admin.query(`DELETE FROM "account" WHERE "userId" = $1`, [sso.id]);

    const responses = await Promise.all([forgot(known.email), forgot(unknown), forgot(sso.email)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual(bodies[2]);

    // Every address produced the same shape of row: sealed address, no account id, no token.
    const rows = await queuedRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'queued', attempts: 0, user_id: null, token_sealed: null, claim_id: null });
      expect(row.email_sealed).toBeTruthy();
      expect(row.email_sealed?.includes(Buffer.from(known.email))).toBe(false);
    }
    const opened = rows.map((row) => ({ row, email: openResetEmail(t.srv.authSecret, row.email_sealed!) }));
    expect(opened.map((entry) => entry.email).sort()).toEqual([known.email, sso.email, unknown].sort());
    const unknownQueued = opened.find((entry) => entry.email === unknown)!.row;
    // No Better Auth token was minted and no provider was called on the request path.
    expect(await verificationRows(known.id)).toHaveLength(0);
    expect(await verificationRows(sso.id)).toHaveLength(0);
    expect(outbox).toHaveLength(0);

    const summary = await deliver();
    expect(summary).toMatchObject({ handled: 3, sent: 1, failed: 0, skipped: 2 });
    expect(mailsTo(known.email)).toHaveLength(1);
    expect(mailsTo(unknown)).toHaveLength(0);
    expect(mailsTo(sso.email)).toHaveLength(0);
    expect((await queueRows(known.id))[0]).toMatchObject({ status: 'sent', outcome: 'sent' });
    expect((await queueRows(sso.id))[0]).toMatchObject({ status: 'skipped', outcome: 'no_password' });
    const unknownAfter = (await allRows()).find((row) => row.id === unknownQueued.id);
    expect(unknownAfter).toMatchObject({ status: 'skipped', outcome: 'unknown', email_sealed: null, token_sealed: null });
  });

  it('answers neutrally even when the durable insert fails, regardless of the address', async () => {
    const fake = { admin: { query: async () => Promise.reject(new Error('database unavailable')) } } as unknown as Db;
    await expect(enqueueResetRequest({ db: fake, secret: 's'.repeat(32) }, 'known@example.com', '203.0.113.9')).rejects.toThrow(
      'database unavailable',
    );
    await expect(enqueueResetRequest({ db: fake, secret: 's'.repeat(32) }, 'unknown@example.com', '203.0.113.9')).rejects.toThrow(
      'database unavailable',
    );

    // The route answers the same neutral body for both when the insert fails.
    const app = new Hono();
    passwordResetRoutes(app, {
      auth: {} as never,
      db: fake,
      hot: { take: async () => true } as never,
      publicUrl: BASE,
      authSecret: 's'.repeat(32),
      clientIpHeaders: ['x-forwarded-for'],
      trustedProxyCidrs: ['0.0.0.0/0', '::/0'],
    });
    const call = (email: string, ip: string) =>
      app.request('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, origin: BASE },
        body: JSON.stringify({ email }),
      });
    const known = await call('known@example.com', '198.51.100.20');
    const unknown = await call('unknown@example.com', '198.51.100.21');
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });
});

describe('reset limiter availability', () => {
  it.each([1, 2, 3])('refuses to enqueue all aliases when bucket %i is unavailable', async (failAt) => {
    let calls = 0;
    let writes = 0;
    let forwards = 0;
    const fake = {
      admin: {
        query: async () => {
          writes++;
          return { rows: [] };
        },
      },
    } as unknown as Db;
    const app = new Hono();
    passwordResetRoutes(app, {
      auth: {
        handler: async () => {
          forwards++;
          return new Response();
        },
      } as never,
      db: fake,
      hot: {
        take: async () => {
          if (++calls === failAt) throw new Error('Valkey unavailable');
          return true;
        },
      } as never,
      publicUrl: BASE,
      authSecret: 's'.repeat(32),
      clientIpHeaders: [],
      trustedProxyCidrs: [],
    });
    const responses: unknown[] = [];
    for (const alias of ['forgot-password', 'forget-password', 'request-password-reset']) {
      for (const email of [owner.email, 'unknown@example.com']) {
        calls = 0;
        const response = await app.request(`/api/auth/${alias}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        expect(response.status).toBe(503);
        responses.push(await response.json());
      }
    }
    expect(responses.every((body) => JSON.stringify(body) === JSON.stringify(responses[0]))).toBe(true);
    expect(responses[0]).toMatchObject({ status: false, code: 'RATE_LIMIT_UNAVAILABLE' });
    expect(writes).toBe(0);
    expect(forwards).toBe(0);
  });

  it('does not forward a reset submission while its shared limiter is unavailable', async () => {
    let forwards = 0;
    const app = new Hono();
    passwordResetRoutes(app, {
      auth: {
        handler: async () => {
          forwards++;
          return new Response();
        },
      } as never,
      db: {} as Db,
      hot: {
        take: async () => {
          throw new Error('Valkey unavailable');
        },
      } as never,
      publicUrl: BASE,
      authSecret: 's'.repeat(32),
      clientIpHeaders: [],
      trustedProxyCidrs: [],
    });
    const response = await app.request('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'pending', newPassword: NEW_PASSWORD }),
    });
    expect(response.status).toBe(503);
    expect(forwards).toBe(0);
  });
});

describe('the reset delivery queue (#379)', () => {
  const failingSender = async () => 'failed' as const;

  it('retries a provider failure with backoff and stops at the attempt bound', async () => {
    await ensureTransactionalProvider();
    const account = await newAccount();
    expect((await forgot(account.email)).status).toBe(200);

    let summary = await deliver(failingSender);
    expect(summary).toMatchObject({ handled: 1, retried: 1, failed: 0 });
    let [row] = await queueRows(account.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(row!.next_attempt_at).toBeTruthy();
    expect(row!.token_sealed).toBeTruthy();
    const pendingToken = openResetToken(t.srv.authSecret, row!.token_sealed!);

    // Not due yet: the backoff holds it even though the worker runs again.
    summary = await deliver(failingSender);
    expect(summary.handled).toBe(0);

    for (let attempt = 2; attempt <= 4; attempt++) {
      await t.srv.db.admin.query('UPDATE password_reset_deliveries SET next_attempt_at = now() WHERE user_id = $1', [account.id]);
      summary = await deliver(failingSender);
    }
    expect(summary).toMatchObject({ handled: 1, retried: 0, failed: 1 });
    [row] = await queueRows(account.id);
    // Four attempts is the bound; the payload is gone and the failure is audited.
    expect(row).toMatchObject({ status: 'failed', outcome: 'delivery_failed', attempts: 4, token_sealed: null, email_sealed: null });
    expect(row!.last_error).toBe('delivery_failed');
    const audits = await auditRows(account.id);
    expect(audits.at(-1)?.error).toContain('delivery_failed');
    const serialised = JSON.stringify({ row, audits });
    expect(serialised).not.toContain(pendingToken);
    expect(serialised).not.toContain(account.email);
  }, 30_000);

  it.each(['failed', 'no_sender'] as const)(
    'fences a stale worker returning %s after the successor sends',
    async (lateResult) => {
      await ensureTransactionalProvider();
      const account = await newAccount();
      await forgot(account.email);

      let releaseLate!: () => void;
      const lateMayFinish = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      let lateStarted!: () => void;
      const lateIsSending = new Promise<void>((resolve) => {
        lateStarted = resolve;
      });
      // Worker A claims the row, mints the token and blocks inside the provider call.
      const lateWorker = deliver(async () => {
        lateStarted();
        await lateMayFinish;
        return lateResult;
      });
      await lateIsSending;

      // The lease looks stale (a 20-minute-old claim), so worker B may take it over.
      await t.srv.db.admin.query(
        `UPDATE password_reset_deliveries SET updated_at = now() - interval '20 minutes' WHERE user_id = $1 AND status = 'sending'`,
        [account.id],
      );
      const successor = await deliver();
      expect(successor).toMatchObject({ handled: 1, sent: 1, failed: 0 });

      // A finishes late with a failure. Its retry/settle writes are fenced by the old claim id.
      releaseLate();
      const late = await lateWorker;
      expect(late).toMatchObject({ handled: 1, sent: 0, failed: 0, retried: 0, superseded: 1 });

      const [row] = await queueRows(account.id);
      expect(row).toMatchObject({ status: 'sent', outcome: 'sent', email_sealed: null, token_sealed: null });
      expect(mailsTo(account.email)).toHaveLength(1);
      // One durable outcome only: the late failure appended no contradictory audit entry.
      expect(await auditRows(account.id)).toEqual([{ ok: true, error: null, ip: expect.any(String) }]);
      // In particular, late no_sender must not delete the successor's shared verification token.
      const deliveredToken = linkToken(mailsTo(account.email)[0]);
      expect((await reset(deliveredToken, NEW_PASSWORD)).status).toBe(200);
    },
    30_000,
  );

  it('re-checks eligibility after enqueue and does not mail a removed credential', async () => {
    await ensureTransactionalProvider();
    const account = await newAccount();
    await forgot(account.email);
    // The person becomes SSO-only while the request waits in the queue.
    await t.srv.db.admin.query(`DELETE FROM "account" WHERE "userId" = $1`, [account.id]);

    const summary = await deliver();
    expect(summary).toMatchObject({ handled: 1, sent: 0, skipped: 1 });
    expect(mailsTo(account.email)).toHaveLength(0);
    expect((await queueRows(account.id))[0]).toMatchObject({ status: 'skipped', outcome: 'no_password', token_sealed: null });
    expect((await auditRows(account.id)).at(-1)?.error).toContain('no_password');
  });

  it('re-checks enforced single sign-on after enqueue', async () => {
    await ensureTransactionalProvider();
    const domain = `sso-${runId}.test`;
    const account = await newAccountAt(`person-${Date.now()}@${domain}`);
    await forgot(account.email);
    // The domain becomes enforced single sign-on while the request waits in the queue.
    await t.srv.db.admin.query(
      `INSERT INTO "ssoProvider" (id, issuer, "userId", "providerId", domain, "workspaceId", "domainVerified", enforced)
       VALUES ($1, $2, $3, $4, $5, $6, true, true)`,
      [`sso-${runId}`, 'https://idp.example', owner.id, `provider-${runId}`, domain, ws],
    );

    const summary = await deliver();
    expect(summary).toMatchObject({ handled: 1, sent: 0, skipped: 1 });
    expect(mailsTo(account.email)).toHaveLength(0);
    expect((await queueRows(account.id))[0]).toMatchObject({ status: 'skipped', outcome: 'sso_only', token_sealed: null });
    expect((await auditRows(account.id)).at(-1)?.error).toContain('sso_only');
  });

  it.each(['credential', 'sso', 'address', 'owner'] as const)(
    'revokes a retry token after an eligibility or ownership change: %s',
    async (change) => {
      await ensureTransactionalProvider();
      const domain = `revoke-${Date.now()}-${change}.test`;
      const account = await newAccountAt(`person@${domain}`);
      await forgot(account.email);
      expect(await deliver(failingSender)).toMatchObject({ retried: 1 });
      const [pending] = await queueRows(account.id);
      expect(pending.token_sealed).toBeTruthy();
      expect(await verificationRows(account.id)).toHaveLength(1);
      if (change === 'credential') {
        await t.srv.db.admin.query('DELETE FROM "account" WHERE "userId" = $1 AND "providerId" = $2', [account.id, 'credential']);
      } else if (change === 'sso') {
        await t.srv.db.admin.query(
          `INSERT INTO "ssoProvider" (id, issuer, "userId", "providerId", domain, "workspaceId", "domainVerified", enforced)
         VALUES ($1, $2, $3, $4, $5, $6, true, true)`,
          [`revoke-${domain}`, 'https://idp.example', owner.id, `provider-${domain}`, domain, ws],
        );
      } else {
        await t.srv.db.admin.query('UPDATE "user" SET email = $2 WHERE id = $1', [account.id, `moved@${domain}`]);
        if (change === 'owner') await newAccountAt(account.email);
      }
      await t.srv.db.admin.query('UPDATE password_reset_deliveries SET next_attempt_at = now() WHERE id = $1', [pending.id]);
      const result = await deliver();
      expect(result).toMatchObject({ handled: 1, sent: 0 });
      const [settled] = await queueRows(account.id);
      expect(settled).toMatchObject({
        status: change === 'credential' || change === 'sso' ? 'skipped' : 'failed',
        outcome: change === 'credential' ? 'no_password' : change === 'sso' ? 'sso_only' : 'account_gone',
        token_sealed: null,
      });
      expect(await verificationRows(account.id)).toHaveLength(0);
      expect(mailsTo(account.email)).toHaveLength(0);
    },
    30_000,
  );

  it('releases idle abort listeners between ticks', async () => {
    const controller = new AbortController();
    let claims = 0;
    let mostListeners = 0;
    const fake = {
      admin: {
        query: async (query: string) => {
          mostListeners = Math.max(mostListeners, getEventListeners(controller.signal, 'abort').length);
          if (query.includes('claim_id = gen_random_uuid') && ++claims === 30) controller.abort();
          return { rows: [], rowCount: 0 };
        },
      },
    } as unknown as Db;
    await runPasswordResetDeliveries(
      {
        db: fake,
        auth: t.srv.auth,
        kp: t.srv.keyProvider,
        email: t.srv.email,
        directory: t.srv.directory,
        publicUrl: t.base,
        ttlSeconds: RESET_PASSWORD_TTL_SECONDS,
        secret: t.srv.authSecret,
      },
      controller.signal,
      { tickMs: 1 },
    );
    expect(claims).toBe(30);
    expect(mostListeners).toBeLessThanOrEqual(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not mail an expired or consumed queued token', async () => {
    await ensureTransactionalProvider();
    const expired = await newAccount();
    await forgot(expired.email);
    expect(await deliver(failingSender)).toMatchObject({ handled: 1, retried: 1 });
    const [expiredRow] = await queueRows(expired.id);
    const expiredToken = openResetToken(t.srv.authSecret, expiredRow!.token_sealed!);
    await t.srv.db.admin.query(`UPDATE "verification" SET "expiresAt" = now() - interval '1 minute' WHERE identifier = $1`, [
      hashedResetTokenIdentifier(expiredToken),
    ]);
    await t.srv.db.admin.query('UPDATE password_reset_deliveries SET next_attempt_at = now() WHERE user_id = $1', [expired.id]);
    expect(await deliver()).toMatchObject({ handled: 1, failed: 1 });
    expect(mailsTo(expired.email)).toHaveLength(0);
    expect((await queueRows(expired.id))[0]).toMatchObject({ status: 'failed', outcome: 'expired', token_sealed: null });
    expect(await verificationRows(expired.id)).toHaveLength(0);

    const consumed = await newAccount();
    await forgot(consumed.email);
    expect(await deliver(failingSender)).toMatchObject({ handled: 1, retried: 1 });
    // A link used elsewhere disappears from Better Auth's verification table.
    await t.srv.db.admin.query('DELETE FROM "verification" WHERE value = $1', [consumed.id]);
    await t.srv.db.admin.query('UPDATE password_reset_deliveries SET next_attempt_at = now() WHERE user_id = $1', [consumed.id]);
    expect(await deliver()).toMatchObject({ handled: 1, failed: 1 });
    expect(mailsTo(consumed.email)).toHaveLength(0);
    expect((await queueRows(consumed.id))[0]).toMatchObject({ status: 'failed', outcome: 'consumed', token_sealed: null });
  }, 30_000);

  it('bounds retention for unprocessed requests and prunes settled rows', async () => {
    await ensureTransactionalProvider();
    const account = await newAccount();
    await forgot(account.email);
    const queued = await rowFor(account.email);
    expect(queued).toBeTruthy();
    // A deployment that never ran the worker for a day: the sealed address is expired and wiped.
    await t.srv.db.admin.query(
      `UPDATE password_reset_deliveries SET created_at = now() - interval '25 hours', updated_at = now() - interval '25 hours' WHERE id = $1`,
      [queued!.id],
    );
    expect(await deliver()).toMatchObject({ handled: 0 });
    const expired = (await allRows()).find((row) => row.id === queued!.id);
    expect(expired).toMatchObject({ status: 'failed', outcome: 'expired', email_sealed: null, token_sealed: null });
    // The cleanup resolves the address only to record the durable outcome.
    expect((await auditRows(account.id)).at(-1)?.error).toContain('expired');

    // Terminal rows are pruned after the seven-day retention window.
    await t.srv.db.admin.query(`UPDATE password_reset_deliveries SET updated_at = now() - interval '8 days' WHERE id = $1`, [queued!.id]);
    await deliver();
    expect((await allRows()).find((row) => row.id === queued!.id)).toBeUndefined();
  });

  it('recovers a row a stopped worker left sending', async () => {
    await ensureTransactionalProvider();
    const account = await newAccount();
    await forgot(account.email);
    const queued = await rowFor(account.email);
    expect(queued).toBeTruthy();
    await t.srv.db.admin.query(
      `UPDATE password_reset_deliveries
          SET status = 'sending', claim_id = gen_random_uuid(), attempts = 1, updated_at = now() - interval '20 minutes'
        WHERE id = $1 AND status = 'queued'`,
      [queued!.id],
    );
    // The token was never minted by the stopped worker; the takeover mints it and sends.
    const summary = await deliver();
    expect(summary).toMatchObject({ handled: 1, sent: 1 });
    expect(mailsTo(account.email)).toHaveLength(1);
  }, 30_000);
});

describe('the audit trail (#191)', () => {
  it('records the request and the reset with the person and IP, never the token', async () => {
    const account = await newAccount();
    const ip = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
    await requestLink(account.email, ip);
    const token = linkToken(mailsTo(account.email)[0]);
    expect((await reset(token, NEW_PASSWORD, ip)).status).toBe(200);

    const { rows } = await t.srv.db.admin.query<{
      command: string;
      principal_id: string;
      surface: string;
      ok: boolean;
      error: string | null;
      ip: string | null;
    }>(`SELECT command, principal_id, surface, ok, error, ip FROM audit_log WHERE principal_id = $1 ORDER BY seq`, [account.id]);
    expect(rows.map((r) => r.command)).toEqual(['auth.passwordResetRequest', 'auth.passwordReset']);
    expect(rows.every((r) => r.surface === 'internal' && r.ok)).toBe(true);
    expect(rows.map((r) => r.ip)).toEqual([ip, ip]);
    // Nothing in the entry can be replayed as the link or the password.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(NEW_PASSWORD);

    // The appends keep the workspace's hash chain intact, and an auditor reads the IP back.
    expect(await t.api(owner, ws).call('audit.verify', {})).toMatchObject({ ok: true });
    const { entries } = await t.api(owner, ws).call('audit.list', { limit: 500 });
    expect(entries.filter((e) => e.principalId === account.id).map((e) => e.ip)).toEqual([ip, ip]);
  });
});
