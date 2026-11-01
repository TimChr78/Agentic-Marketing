import type { Auth } from '@agentic-marketing/auth';
import { RESOLVED_CLIENT_IP_HEADER, remoteAddressFromEnv, resolveClientIp, sha256 } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import type { HotState } from '@agentic-marketing/hotstate';
import { logger } from '@agentic-marketing/telemetry';
import type { Context, Hono } from 'hono';
import {
  accountForEmail,
  hasPasswordAccount,
  RESET_COOLDOWN_SECONDS,
  RESET_EMAIL_BUCKET,
  RESET_IP_BUCKET,
  RESET_REQUEST_MESSAGE,
  RESET_SUBMIT_IP_BUCKET,
  type ResetDeliveryDeps,
  recordPasswordResetAudit,
  resetTokenAccount,
  sendPasswordResetEmail,
  ssoOnlyDomain,
} from '../passwordReset';

// The self-service password reset endpoints (#191). Better Auth owns the token and the password
// change; these routes add what it cannot do alone: rate limits shared across workers, the
// account checks (no mail for single sign-on people) and the audit trail.
//
// Both endpoints answer the same way whether or not the address exists.

export interface PasswordResetRoutesDeps {
  auth: Auth;
  db: Db;
  hot: HotState;
  publicUrl: string;
  clientIpHeaders: string[];
  trustedProxyCidrs: string[];
  /** Provider transport, key provider and directory for the reset e-mail. */
  mail: ResetDeliveryDeps;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_LINK = 'This reset link is not valid any more. Ask for a new one.';
const TOO_MANY = 'Too many attempts. Wait a few minutes and try again.';

const neutral = () => ({ status: true, message: RESET_REQUEST_MESSAGE });

/** Whether this person may reset a password, or why not. Never reveals the answer to the caller. */
export async function resetEligibility(db: Db, account: { id: string; email: string }): Promise<'ok' | 'sso_only' | 'no_password'> {
  if (await ssoOnlyDomain(db, account.email)) return 'sso_only';
  if (!(await hasPasswordAccount(db, account.id))) return 'no_password';
  return 'ok';
}

/**
 * Sends a link and records the outcome. Wired into Better Auth's `sendResetPassword`, so it only
 * runs for an account that exists; the eligibility check keeps single sign-on people out even if
 * another path reached the callback.
 */
export async function deliverResetLink(
  deps: { db: Db; mail: ResetDeliveryDeps; ttlSeconds: number; ip: string },
  account: { id: string; email: string; name: string },
  token: string,
) {
  const eligibility = await resetEligibility(deps.db, account);
  if (eligibility !== 'ok') {
    await recordPasswordResetAudit(deps.db, {
      userId: account.id,
      ip: deps.ip,
      command: 'auth.passwordResetRequest',
      outcome: eligibility,
    });
    return;
  }
  const result = await sendPasswordResetEmail(deps.mail, account, token, deps.ttlSeconds);
  await recordPasswordResetAudit(deps.db, {
    userId: account.id,
    ip: deps.ip,
    command: 'auth.passwordResetRequest',
    outcome: result === 'sent' ? 'sent' : result === 'no_sender' ? 'no_sender' : 'delivery_failed',
  });
}

export function passwordResetRoutes(app: Hono, deps: PasswordResetRoutesDeps) {
  /** The same resolution Better Auth gets, so the limits are per real client and shared. */
  const clientIp = (c: Context) =>
    resolveClientIp({
      header: (name) => c.req.raw.headers.get(name) ?? undefined,
      remoteAddress: remoteAddressFromEnv(c.env),
      headerNames: deps.clientIpHeaders,
      trustedProxyCidrs: deps.trustedProxyCidrs,
    }) ?? 'unknown';

  /** A token bucket shared by every worker. Valkey trouble must not lock everyone out. */
  async function take(key: string, bucket: { rate: number; burst: number }) {
    try {
      return await deps.hot.take(key, 1, bucket.rate, bucket.burst);
    } catch (err) {
      logger.warn({ err, key }, 'password reset rate limit unavailable; allowing the request');
      return true;
    }
  }

  const tooMany = (c: Context) => c.json({ status: false, code: 'RATE_LIMITED', message: TOO_MANY }, 429, { 'retry-after': '60' });

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const parsed = await c.req.json().catch(() => null);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  };

  /** Forwards a request to Better Auth, keeping the caller's headers (origin check included). */
  async function forward(c: Context, path: string, payload: unknown, ip: string) {
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    headers.set(RESOLVED_CLIENT_IP_HEADER, ip);
    const request = new Request(new URL(path, deps.publicUrl), { method: 'POST', headers, body: JSON.stringify(payload) });
    return deps.auth.handler(request);
  }

  async function requested(c: Context) {
    const ip = clientIp(c);
    const input = await body(c);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!email || email.length > 320 || !EMAIL.test(email)) return c.json({ status: false, message: 'Enter a valid e-mail address.' }, 400);

    // Per IP first, then per address, both independent of whether the account exists.
    if (!(await take(`pwreset:ip:${ip}`, RESET_IP_BUCKET))) return tooMany(c);
    if (!(await take(`pwreset:email:${sha256(email)}`, RESET_EMAIL_BUCKET))) return tooMany(c);
    // A short cooldown keeps one impatient person from filling a mailbox; the answer stays neutral.
    if (!(await take(`pwreset:cooldown:${sha256(email)}`, { rate: 1 / RESET_COOLDOWN_SECONDS, burst: 1 }))) return c.json(neutral());

    const account = await accountForEmail(deps.db, email);
    // An unknown address gets no token and no mail, and the same answer as a known one.
    if (!account) return c.json(neutral());

    const eligibility = await resetEligibility(deps.db, account);
    if (eligibility !== 'ok') {
      await recordPasswordResetAudit(deps.db, { userId: account.id, ip, command: 'auth.passwordResetRequest', outcome: eligibility });
      return c.json(neutral());
    }

    const response = await forward(c, '/api/auth/request-password-reset', { email }, ip);
    // Better Auth sends the mail through `sendResetPassword` (see deliverResetLink) and records
    // the audit entry with the outcome. A provider failure keeps this answer neutral.
    if (!response.ok) logger.warn({ status: response.status }, 'a password reset request was refused by the auth layer');
    return c.json(neutral());
  }

  async function resetPassword(c: Context) {
    const ip = clientIp(c);
    if (!(await take(`pwreset:submit:ip:${ip}`, RESET_SUBMIT_IP_BUCKET))) return tooMany(c);
    const input = await body(c);
    const token = typeof input.token === 'string' ? input.token : '';
    const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';
    if (!token || token.length > 512) return c.json({ status: false, code: 'INVALID_TOKEN', message: INVALID_LINK }, 400);

    // Read before Better Auth consumes it, so the audit entry names the person. Expired and used
    // tokens are not found here; Better Auth still has the last word on the token itself.
    const found = await resetTokenAccount(deps.db, token);
    const response = await forward(c, '/api/auth/reset-password', { token, newPassword }, ip);
    if (response.ok) {
      await recordPasswordResetAudit(deps.db, { userId: found?.userId ?? null, ip, command: 'auth.passwordReset', outcome: 'ok' });
      return c.json({ status: true, message: 'Your password has been changed. Sign in with your new password.' });
    }
    const failure = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
    await recordPasswordResetAudit(deps.db, {
      userId: found?.userId ?? null,
      ip,
      command: 'auth.passwordReset',
      outcome: failure.code === 'PASSWORD_TOO_SHORT' ? 'password_too_short' : 'invalid_token',
    });
    // Expired, reused and malformed tokens all read the same; a too-short password keeps its own reason.
    if (failure.code === 'INVALID_TOKEN') return c.json({ status: false, code: 'INVALID_TOKEN', message: INVALID_LINK }, 400);
    return c.json({ status: false, code: failure.code ?? 'BAD_REQUEST', message: failure.message ?? INVALID_LINK }, 400);
  }

  // Before the `/api/auth/*` handler: these paths (and Better Auth's own names for them) are
  // rate limited and audited here. `forget-password` is the name issue #191 uses.
  app.post('/api/auth/forgot-password', requested);
  app.post('/api/auth/forget-password', requested);
  app.post('/api/auth/request-password-reset', requested);
  app.post('/api/auth/reset-password', resetPassword);
}
