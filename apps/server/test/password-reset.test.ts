import { hashedResetTokenIdentifier } from '@agentic-marketing/auth';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieOf, startTestServer, testPort, type User } from './harness';

// Self-service password reset (#191): the neutral answer, the mailed link, the password change,
// single use and expiry, session revocation, the rate limits, single sign-on people and the audit.

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

/** The token in the one link the reset mail carries. */
function linkToken(mail: { text: string }): string {
  const url = /https?:\/\/\S+/.exec(mail.text)?.[0];
  const token = url ? new URL(url).searchParams.get('token') : null;
  if (!token) throw new Error(`the reset mail has no token in its link: ${mail.text}`);
  return token;
}

async function newAccount(): Promise<User> {
  const u = await t.signUp(`reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`);
  await t.srv.db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'marketer')`, [ws, u.id]);
  return u;
}

beforeAll(async () => {
  t = await startTestServer('test_pwreset', PORT);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 90_000);
afterAll(() => t?.close());
beforeEach(() => {
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
    // No sender: no mail, no crash, and the same answer a person with mail would see.
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
    expect(mailsTo(known.email)).toHaveLength(1);
    expect(mailsTo(unknown)).toHaveLength(0);
  });

  it('mails a single-use link to PUBLIC_URL that sets the new password', async () => {
    const account = await newAccount();
    expect((await forgot(account.email)).status).toBe(200);
    const mail = mailsTo(account.email)[0];
    expect(mail).toBeTruthy();
    expect(mail.from.email).toBe('security@example.com');
    expect(mail.text).toContain(`${BASE}/reset-password?token=`);
    expect(mail.html).toContain(`${BASE}/reset-password?token=`);
    // No tracking pixel, and the sender is the workspace's provider, not a brand guess.
    expect(mail.html).not.toMatch(/<img/i);
    const token = linkToken(mail);

    // The token is stored hashed: a dump of the table never yields a usable link.
    const { rows } = await t.srv.db.admin.query<{ identifier: string }>('SELECT identifier FROM "verification" WHERE value = $1', [
      account.id,
    ]);
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
    await forgot(account.email);
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

    await forgot(account.email);
    expect((await reset(linkToken(mailsTo(account.email)[0]), NEW_PASSWORD)).status).toBe(200);

    expect(await sessionOf(cookieOf(first))).toBeNull();
    expect(await sessionOf(cookieOf(second))).toBeNull();
  });

  it('does not mail a person who signs in with single sign-on only', async () => {
    const account = await newAccount();
    // What an SSO/SCIM-provisioned person looks like: an account with no password credential.
    await t.srv.db.admin.query(`DELETE FROM "account" WHERE "userId" = $1`, [account.id]);
    const res = await forgot(account.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: true });
    expect(mailsTo(account.email)).toHaveLength(0);
  });

  it('does not send a second link inside the cooldown', async () => {
    const account = await newAccount();
    await forgot(account.email);
    await forgot(account.email);
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

    expect((await forgot(account.email)).status).toBe(200);
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

describe('the audit trail (#191)', () => {
  it('records the request and the reset with the person and IP, never the token', async () => {
    const account = await newAccount();
    const ip = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
    await forgot(account.email, ip);
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
