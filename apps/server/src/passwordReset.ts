import { hkdfSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { type Auth, hashedResetTokenIdentifier, inAuthTransaction, mintResetVerification } from '@agentic-marketing/auth';
import { appendAuditEntry, type Principal } from '@agentic-marketing/commands';
import { newId, sha256 } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { open, seal } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';

// Self-service password reset (#191), the server side of Better Auth's reset flow:
//
//   request → rate limit → seal the address → durable queue (no account lookup, no token, no I/O)
//   worker  → decrypt → account/eligibility checks → Better Auth token → send → bounded retries
//   reset   → rate limit → token lookup (for the audit entry) → Better Auth sets the password
//           and revokes every session of that person.
//
// The request path is deliberately account-agnostic (#379): every syntactically valid normalized
// address performs the same bounded local crypto and the same single durable insert. Only the
// worker looks an address up, so known, unknown and single sign-on addresses cannot be told apart
// by request work. The flow is installation-level: the link points at PUBLIC_URL, never at a
// brand's domain. A person who belongs to several workspaces gets one link, sent through the
// transactional provider of their oldest workspace, so the sender is one they belong to and never
// a stranger's brand.

/** How long the same address has to wait before another link is sent, in seconds. */
export const RESET_COOLDOWN_SECONDS = 60;
/** A link request per address and per IP, as a token bucket: sustained rate and burst. */
export const RESET_EMAIL_BUCKET = { rate: 3 / 3600, burst: 3 };
export const RESET_IP_BUCKET = { rate: 5 / 900, burst: 5 };
/** Resetting a password is rare; this only stops a flood against the token check. */
export const RESET_SUBMIT_IP_BUCKET = { rate: 10 / 900, burst: 10 };

/** The neutral answer: identical whether or not the address exists, and whether mail went out. */
export const RESET_REQUEST_MESSAGE = 'If an account exists for that address, we sent a link to reset the password.';

/** The outcome of a reset request or completion, as recorded in the audit log. */
export type ResetOutcome =
  | 'sent'
  | 'unknown'
  | 'no_password'
  | 'sso_only'
  | 'no_sender'
  | 'delivery_failed'
  | 'expired'
  | 'consumed'
  | 'account_gone'
  | 'email_unreadable'
  | 'ok'
  | 'invalid_token'
  | 'password_too_short';

export interface ResetAccount {
  id: string;
  email: string;
  name: string;
}

/** The account behind an address, or null. Compared case-insensitively, like sign-in. */
export async function accountForEmail(db: Db, email: string): Promise<ResetAccount | null> {
  const { rows } = await db.admin.query<ResetAccount>('SELECT id, email, name FROM "user" WHERE lower(email) = lower($1) LIMIT 1', [email]);
  return rows[0] ?? null;
}

/** Whether the person has a password account (single sign-on and SCIM people may have none). */
export async function hasPasswordAccount(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.admin.query('SELECT 1 FROM "account" WHERE "userId" = $1 AND "providerId" = \'credential\' LIMIT 1', [userId]);
  return rows.length > 0;
}

/** An enforced (verified) single sign-on provider owns the address's domain: passwords are off there. */
export async function ssoOnlyDomain(db: Db, email: string): Promise<boolean> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const { rows } = await db.admin.query(`SELECT 1 FROM "ssoProvider" WHERE lower(domain) = $1 AND enforced AND "domainVerified" LIMIT 1`, [
    domain,
  ]);
  return rows.length > 0;
}

/** Whether this person may reset a password, or why not. Never reveals the answer to the caller. */
export async function resetEligibility(db: Db, account: { id: string; email: string }): Promise<'ok' | 'sso_only' | 'no_password'> {
  if (await ssoOnlyDomain(db, account.email)) return 'sso_only';
  if (!(await hasPasswordAccount(db, account.id))) return 'no_password';
  return 'ok';
}

/**
 * The workspace whose transactional provider sends the person's reset link: their oldest
 * membership that has an enabled transactional provider. Null when there is none, in which case
 * the request is still answered neutrally and the operator gets a warning (the CLI is the fallback).
 */
export async function senderWorkspaceFor(db: Db, userId: string): Promise<string | null> {
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    `SELECT m.workspace_id
       FROM workspace_members m
       JOIN email_providers p ON p.workspace_id = m.workspace_id
      WHERE m.user_id = $1 AND p.enabled AND 'transactional' = ANY(p.use_for)
      ORDER BY m.created_at, m.workspace_id
      LIMIT 1`,
    [userId],
  );
  return rows[0]?.workspace_id ?? null;
}

/** The verification row a still-valid reset token belongs to, or null when absent (consumed). */
export async function resetTokenState(db: Db, token: string): Promise<{ userId: string; expiresAt: Date } | null> {
  if (!token) return null;
  const { rows } = await db.admin.query<{ value: string; expiresAt: Date }>(
    'SELECT value, "expiresAt" FROM "verification" WHERE identifier = $1 ORDER BY "createdAt" DESC LIMIT 1',
    [hashedResetTokenIdentifier(token)],
  );
  const row = rows[0];
  return row ? { userId: row.value, expiresAt: new Date(row.expiresAt) } : null;
}

/** The user id a still-valid reset token belongs to, or null. Reads the token's hashed identifier. */
export async function resetTokenAccount(db: Db, token: string): Promise<{ userId: string } | null> {
  const state = await resetTokenState(db, token);
  return state && state.expiresAt.getTime() > Date.now() ? { userId: state.userId } : null;
}

/** Removes an expired verification row so it can never be consumed later. */
async function deleteResetToken(db: Db, token: string): Promise<void> {
  await db.admin.query('DELETE FROM "verification" WHERE identifier = $1', [hashedResetTokenIdentifier(token)]);
}

/** Deletes a shared retry token only while this claim still owns the row.
 * The row lock serializes against takeover, so a stale sender cannot invalidate its successor's link.
 */
async function deleteClaimedResetToken(db: Db, token: string, row: QueuedResetRow): Promise<void> {
  await db.admin.query(
    `WITH owned AS MATERIALIZED (
       SELECT id FROM password_reset_deliveries
        WHERE id = $2 AND status = 'sending' AND claim_id = $3
        FOR UPDATE
     )
     DELETE FROM "verification"
      WHERE identifier = $1 AND EXISTS (SELECT 1 FROM owned)`,
    [hashedResetTokenIdentifier(token), row.id, row.claim_id],
  );
}

// The request path never touches a tenant data key or a network KEK. Addresses and worker-minted
// tokens are sealed with purpose-separated keys derived from the installation secret (AUTH_SECRET):
// HKDF-SHA256 gives each purpose its own 32-byte AES-256-GCM key, so a ciphertext from one purpose
// cannot be opened as the other. This is local CPU work only, identical for every address.
const RESET_EMAIL_KEY_INFO = 'agentic-marketing:password-reset-email:v1';
const RESET_TOKEN_KEY_INFO = 'agentic-marketing:password-reset-token:v1';
const SEAL_IV = 12;
const SEAL_TAG = 16;

function purposeKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

function sealPurpose(secret: string, info: string, value: string): Buffer {
  const sealed = seal(purposeKey(secret, info), Buffer.from(value, 'utf8'));
  return Buffer.concat([sealed.iv, sealed.authTag, sealed.ciphertext]);
}

function openPurpose(secret: string, info: string, blob: Buffer): string {
  return open(purposeKey(secret, info), {
    iv: blob.subarray(0, SEAL_IV),
    authTag: blob.subarray(SEAL_IV, SEAL_IV + SEAL_TAG),
    ciphertext: blob.subarray(SEAL_IV + SEAL_TAG),
  }).toString('utf8');
}

/** Seals the normalized address for the durable request queue. */
export function sealResetEmail(secret: string, email: string): Buffer {
  return sealPurpose(secret, RESET_EMAIL_KEY_INFO, email);
}

/** Opens a queued address; a tampered or wrong-secret blob throws. */
export function openResetEmail(secret: string, blob: Buffer): string {
  return openPurpose(secret, RESET_EMAIL_KEY_INFO, blob);
}

/** Seals a worker-minted reset token while a delivery is pending. */
export function sealResetToken(secret: string, token: string): Buffer {
  return sealPurpose(secret, RESET_TOKEN_KEY_INFO, token);
}

/** Opens a pending reset token; a tampered or wrong-secret blob throws. */
export function openResetToken(secret: string, blob: Buffer): string {
  return openPurpose(secret, RESET_TOKEN_KEY_INFO, blob);
}

export interface ResetRequestDeps {
  db: Db;
  /** Installation secret (AUTH_SECRET); rotating it makes queued rows unreadable. */
  secret: string;
}

/**
 * The whole public request work (#379): seal the normalized address and insert one row. There is
 * no account lookup, token generation, tenant KEK use or provider call here, so the work and the
 * write count are the same for a known, unknown and single sign-on address. A database failure
 * propagates to the route, which answers neutrally like every other outcome.
 */
export async function enqueueResetRequest(deps: ResetRequestDeps, email: string, ip: string): Promise<void> {
  await deps.db.admin.query(
    `INSERT INTO password_reset_deliveries (id, email_sealed, ip)
     VALUES ($1, $2, $3)`,
    [newId('prd'), sealResetEmail(deps.secret, email), ip],
  );
}

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function passwordResetEmail(url: string, name: string, ttlSeconds: number) {
  const minutes = Math.round(ttlSeconds / 60);
  const hello = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Reset your Agentic Marketing password';
  const text = [
    hello,
    '',
    'Someone asked to reset the password for this e-mail address on Agentic Marketing.',
    `Open this link to choose a new password. It works once and expires in ${minutes} minutes:`,
    '',
    url,
    '',
    "If you didn't ask for this, ignore this message; your password stays as it is.",
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p>${escapeHtml(hello)}</p>
<p>Someone asked to reset the password for this e-mail address on Agentic Marketing.
Open the link below to choose a new password. It works once and expires in ${minutes} minutes.</p>
<p><a href="${escapeHtml(url)}">Choose a new password</a></p>
<p style="color:#777;font-size:12px">If you didn&rsquo;t ask for this, ignore this message; your password stays as it is.</p>
</body></html>`;
  return { subject, text, html };
}

/** What sending the mail itself needs (the provider, the directory and the public URL). */
export interface ResetMailDeps extends NotifyDeps {
  db: Db;
  /** Admin UI base URL; the reset page lives at `${publicUrl}/reset-password`. */
  publicUrl: string;
}

/**
 * Sends the reset link through the person's transactional provider, recording it in that
 * workspace's message log. Never throws: the caller answers neutrally either way.
 */
export async function sendPasswordResetEmail(
  deps: ResetMailDeps,
  account: ResetAccount,
  token: string,
  ttlSeconds: number,
): Promise<'sent' | 'no_sender' | 'failed'> {
  try {
    const workspaceId = await senderWorkspaceFor(deps.db, account.id);
    if (!workspaceId) {
      logger.warn(
        { userId: account.id },
        'password reset requested but no workspace of this person has an enabled transactional e-mail provider; configure one, or use `am reset-password --email …`',
      );
      return 'no_sender';
    }
    const url = `${deps.publicUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    const content = passwordResetEmail(url, account.name, ttlSeconds);
    const results = await deps.db.withWorkspace(workspaceId, (tx) =>
      sendMemberEmails(tx, deps, workspaceId, [
        {
          userId: account.id,
          // No token in a stored key: a message-log row must never become a usable link.
          idempotencyKey: `password-reset:${sha256(token)}`,
          ...content,
          purpose: 'password_reset',
          data: { passwordReset: true },
        },
      ]),
    );
    const result = results[0];
    if (result?.status === 'sent') return 'sent';
    logger.warn({ userId: account.id, workspaceId }, 'password reset e-mail could not be sent');
    return 'failed';
  } catch (err) {
    // No address or token in the log: only the error class is diagnostic enough here.
    logger.warn({ error: err instanceof Error ? err.name : 'unknown', userId: account.id }, 'password reset e-mail could not be sent');
    return 'failed';
  }
}

/** How many deliveries one queued reset gets before it is recorded failed (bounded queue). */
export const RESET_MAX_ATTEMPTS = 4;
/** Transactional backoff between provider retries, in seconds. The 4th claim is terminal. */
const RESET_RETRY_SECONDS = [10, 30, 60] as const;
/**
 * A worker that stopped mid-send leaves the row "sending". The token is the same, so it is retried
 * after this window rather than failed: a duplicate reset mail is harmless, a lost one is not.
 * One row is claimed immediately before its own send, so a 25-row batch cannot outlive this.
 */
const RESET_STALE_SENDING_SECONDS = 600;
/** Queued/sending rows keep their sealed address and token at most this long. */
const RESET_QUEUE_PAYLOAD_HOURS = 24;
/** Terminal rows are kept for operator visibility, then pruned by the worker. */
const RESET_SETTLED_RETENTION_DAYS = 7;
/** How often the worker loop runs the expiry/prune pass. */
const RESET_CLEANUP_INTERVAL_MS = 5 * 60_000;

export interface ResetQueueDeps extends NotifyDeps {
  db: Db;
  /** Admin UI base URL; the reset page lives at `${publicUrl}/reset-password`. */
  publicUrl: string;
  /** The token lifetime, used in the mail's expiry text. */
  ttlSeconds: number;
  /** Installation secret for the sealed address/token; the worker never uses a tenant KEK for them. */
  secret: string;
  /** Mints tokens through Better Auth's own verification adapter. */
  auth: Auth;
}

export interface ResetDeliveryDeps extends ResetQueueDeps {
  /** Test seam for the provider call; defaults to `sendPasswordResetEmail`. */
  send?: (deps: ResetQueueDeps, account: ResetAccount, token: string, ttlSeconds: number) => Promise<'sent' | 'no_sender' | 'failed'>;
}

interface QueuedResetRow {
  id: string;
  email_sealed: Buffer | null;
  ip: string;
  user_id: string | null;
  token_sealed: Buffer | null;
  attempts: number;
  claim_id: string;
}

export interface ResetDeliverySummary {
  /** Rows claimed in this round. */
  handled: number;
  sent: number;
  /** Terminal failures, including a provider that kept failing. */
  failed: number;
  /** Terminal requests that correctly sent no mail (unknown, single sign-on, no password). */
  skipped: number;
  /** Provider failures left queued for another attempt. */
  retried: number;
  /** A late worker lost its lease; its write was fenced out. */
  superseded: number;
}

type DeliveryResult = 'sent' | 'failed' | 'skipped' | 'retried' | 'superseded';

/**
 * Wipes the payload and records the terminal outcome. The write is fenced by the claim id, so a
 * worker whose lease was taken over cannot rewrite a successor's row or append a contradictory
 * audit entry. Returns false when the lease is no longer ours.
 */
async function settleReset(
  deps: ResetQueueDeps,
  row: QueuedResetRow,
  status: 'sent' | 'failed' | 'skipped',
  outcome: ResetOutcome,
  error: string | null,
): Promise<boolean> {
  const { rows } = await deps.db.admin.query<{ user_id: string | null; ip: string }>(
    `UPDATE password_reset_deliveries
        SET status = $3, outcome = $4, last_error = $5, email_sealed = NULL, token_sealed = NULL,
            claim_id = NULL, next_attempt_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'sending' AND claim_id = $2
      RETURNING user_id, ip`,
    [row.id, row.claim_id, status, outcome, error],
  );
  const settled = rows[0];
  if (!settled) return false;
  if (settled.user_id) {
    await recordPasswordResetAudit(deps.db, {
      userId: settled.user_id,
      ip: settled.ip,
      command: 'auth.passwordResetRequest',
      outcome,
    });
  }
  return true;
}

/** Returns a transient failure to the queue, fenced by the claim id. False means the lease was lost. */
async function retryReset(deps: ResetQueueDeps, row: QueuedResetRow, reason: string): Promise<boolean> {
  const delay = RESET_RETRY_SECONDS[row.attempts - 1];
  if (delay === undefined || row.attempts >= RESET_MAX_ATTEMPTS) return false;
  const res = await deps.db.admin.query(
    `UPDATE password_reset_deliveries
        SET status = 'queued', claim_id = NULL, last_error = $3,
            next_attempt_at = now() + make_interval(secs => $4), updated_at = now()
      WHERE id = $1 AND status = 'sending' AND claim_id = $2`,
    [row.id, row.claim_id, reason, delay],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Claims one due row immediately before its work, or one whose previous worker went stale. The
 * attempt count is incremented on every claim, including a stale takeover, so the bound holds
 * across reclaims. `FOR UPDATE SKIP LOCKED` lets replicas claim different rows without blocking.
 */
async function claimReset(deps: ResetQueueDeps): Promise<QueuedResetRow | null> {
  const { rows } = await deps.db.admin.query<QueuedResetRow>(
    `UPDATE password_reset_deliveries
        SET status = 'sending', attempts = attempts + 1, claim_id = gen_random_uuid(), updated_at = now()
      WHERE id = (
        SELECT id FROM password_reset_deliveries
         WHERE attempts < $2
           AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
             OR (status = 'sending' AND updated_at < now() - make_interval(secs => $1)))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, email_sealed, ip, user_id, token_sealed, attempts, claim_id`,
    [RESET_STALE_SENDING_SECONDS, RESET_MAX_ATTEMPTS],
  );
  return rows[0] ?? null;
}

/**
 * Bounded retention and crash recovery. Unprocessed rows are terminalized and wiped after the
 * payload lifetime; a stale row that already used every attempt is failed; terminal rows are
 * pruned. This runs in the worker, so a deployment without one neither sends nor cleans up.
 */
async function cleanupResetQueue(deps: ResetQueueDeps): Promise<void> {
  const { rows: exhausted } = await deps.db.admin.query<{ user_id: string | null; ip: string }>(
    `UPDATE password_reset_deliveries
        SET status = 'failed', outcome = 'delivery_failed', email_sealed = NULL, token_sealed = NULL,
            claim_id = NULL, next_attempt_at = NULL, last_error = 'attempt_bound_reached', updated_at = now()
      WHERE status = 'sending' AND attempts >= $2 AND updated_at < now() - make_interval(secs => $1)
      RETURNING user_id, ip`,
    [RESET_STALE_SENDING_SECONDS, RESET_MAX_ATTEMPTS],
  );
  for (const row of exhausted) {
    if (row.user_id)
      await recordPasswordResetAudit(deps.db, {
        userId: row.user_id,
        ip: row.ip,
        command: 'auth.passwordResetRequest',
        outcome: 'delivery_failed',
      });
  }
  const { rows: expired } = await deps.db.admin.query<{
    id: string;
    email_sealed: Buffer | null;
    user_id: string | null;
    ip: string;
  }>(
    `WITH candidates AS (
       SELECT id, email_sealed, user_id, ip
         FROM password_reset_deliveries
        WHERE status IN ('queued', 'sending') AND updated_at < now() - make_interval(hours => $1)
        FOR UPDATE SKIP LOCKED
     ), updated AS (
       UPDATE password_reset_deliveries d
          SET status = 'failed', outcome = 'expired', email_sealed = NULL, token_sealed = NULL,
              claim_id = NULL, next_attempt_at = NULL, last_error = 'expired_before_delivery', updated_at = now()
         FROM candidates c
        WHERE d.id = c.id
        RETURNING d.id, c.email_sealed, c.user_id, c.ip
     )
     SELECT * FROM updated`,
    [RESET_QUEUE_PAYLOAD_HOURS],
  );
  for (const row of expired) {
    // An unprocessed row has no account id yet; resolve it only to record the durable outcome.
    let userId = row.user_id;
    if (!userId && row.email_sealed) {
      try {
        userId = (await accountForEmail(deps.db, openResetEmail(deps.secret, row.email_sealed)))?.id ?? null;
      } catch (err) {
        logger.warn({ err, id: row.id }, 'expired password reset address could not be opened');
      }
    }
    if (userId)
      await recordPasswordResetAudit(deps.db, {
        userId,
        ip: row.ip,
        command: 'auth.passwordResetRequest',
        outcome: 'expired',
      });
  }
  await deps.db.admin.query(
    `DELETE FROM password_reset_deliveries
      WHERE status IN ('sent', 'failed', 'skipped') AND updated_at < now() - make_interval(days => $1)`,
    [RESET_SETTLED_RETENTION_DAYS],
  );
}

/**
 * One claimed delivery. Every account-dependent step (lookup, eligibility, token mint, provider
 * I/O) is here, never in the public request. Eligibility, account existence and the token's
 * ownership/expiry/consumption are re-checked immediately before the provider call, so a request
 * queued before SSO enforcement, credential removal or token use does not mail.
 */
async function deliverReset(
  deps: ResetDeliveryDeps,
  row: QueuedResetRow,
  send: NonNullable<ResetDeliveryDeps['send']>,
): Promise<DeliveryResult> {
  const settle = async (status: 'sent' | 'failed' | 'skipped', outcome: ResetOutcome, error: string | null): Promise<DeliveryResult> =>
    (await settleReset(deps, row, status, outcome, error)) ? status : 'superseded';
  // If revocation fails, retain the sealed payload and let stale-claim recovery retry it.
  const dropToken = (token: string) => deleteClaimedResetToken(deps.db, token, row);
  const discardPendingToken = async () => {
    if (!row.token_sealed) return;
    let pending: string;
    try {
      pending = openResetToken(deps.secret, row.token_sealed);
    } catch {
      // A rotated installation secret cannot recover the token; verification expiry still applies.
      logger.warn({ id: row.id }, 'pending verification could not be opened for revocation');
      return;
    }
    await dropToken(pending);
  };
  if (!row.email_sealed) {
    await discardPendingToken();
    return settle('failed', 'email_unreadable', 'email_missing');
  }
  let email: string;
  try {
    email = openResetEmail(deps.secret, row.email_sealed);
  } catch (err) {
    logger.warn({ err, id: row.id }, 'queued password reset address could not be opened');
    await discardPendingToken();
    return settle('failed', 'email_unreadable', 'email_unreadable');
  }

  const account = await accountForEmail(deps.db, email);
  if (!account) {
    // A previously claimed row has an account id: the account is gone, not merely unknown.
    await discardPendingToken();
    return row.user_id ? settle('failed', 'account_gone', 'account_gone') : settle('skipped', 'unknown', null);
  }
  if (row.user_id && row.user_id !== account.id) {
    // The address now belongs to someone else; never mail a token minted for the old account.
    await discardPendingToken();
    return settle('failed', 'account_gone', 'account_changed');
  }
  if (!row.user_id) {
    // Persist the resolved account (fenced by the claim) so a skipped outcome is attributable and
    // auditable, and so a later attempt cannot silently switch to a different account.
    const { rowCount } = await deps.db.admin.query(
      `UPDATE password_reset_deliveries
          SET user_id = $3, updated_at = now()
        WHERE id = $1 AND status = 'sending' AND claim_id = $2`,
      [row.id, row.claim_id, account.id],
    );
    if (!rowCount) return 'superseded';
  }

  const eligibility = await resetEligibility(deps.db, account);
  if (eligibility !== 'ok') {
    await discardPendingToken();
    return settle('skipped', eligibility, null);
  }

  let token: string;
  if (row.token_sealed) {
    try {
      token = openResetToken(deps.secret, row.token_sealed);
    } catch (err) {
      logger.warn({ err, id: row.id }, 'queued password reset token could not be opened');
      return settle('failed', 'invalid_token', 'token_unreadable');
    }
  } else {
    try {
      token = await mintResetVerification(deps.auth, account.id, deps.ttlSeconds);
    } catch (err) {
      // A transient database/auth-context failure is retryable; the attempt bound still applies.
      logger.warn({ err, id: row.id }, 'password reset token could not be minted');
      return (await retryReset(deps, row, 'token_mint_failed')) ? 'retried' : settle('failed', 'delivery_failed', 'token_mint_failed');
    }
    const { rowCount } = await deps.db.admin.query(
      `UPDATE password_reset_deliveries
          SET token_sealed = $3, user_id = $4, updated_at = now()
        WHERE id = $1 AND status = 'sending' AND claim_id = $2`,
      [row.id, row.claim_id, sealResetToken(deps.secret, token), account.id],
    );
    if (!rowCount) {
      // This fresh token was never published to the queue or a sender; no successor can use it.
      await deleteResetToken(deps.db, token).catch((err) =>
        logger.warn({ err, id: row.id }, 'could not remove an unpublished reset token'),
      );
      return 'superseded';
    }
  }

  // Verification ownership, expiry and consumption immediately before delivery.
  const tokenState = await resetTokenState(deps.db, token);
  if (!tokenState) return settle('failed', 'consumed', 'token_consumed');
  if (tokenState.userId !== account.id) {
    await dropToken(token);
    return settle('failed', 'invalid_token', 'token_owner_mismatch');
  }
  if (tokenState.expiresAt.getTime() <= Date.now()) {
    await dropToken(token);
    return settle('failed', 'expired', 'token_expired');
  }

  // The token mint may have taken time, and another request may have changed the account.
  const current = await accountForEmail(deps.db, email);
  if (!current || current.id !== account.id) {
    await dropToken(token);
    return settle('failed', 'account_gone', 'account_gone');
  }
  const currentEligibility = await resetEligibility(deps.db, current);
  if (currentEligibility !== 'ok') {
    await dropToken(token);
    return settle('skipped', currentEligibility, null);
  }

  let result: 'sent' | 'no_sender' | 'failed';
  try {
    result = await send(deps, current, token, deps.ttlSeconds);
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.name : 'unknown', id: row.id }, 'password reset delivery threw');
    result = 'failed';
  }
  if (result === 'sent') return settle('sent', 'sent', null);
  if (result === 'no_sender') {
    // Configuration is not a transient provider error: the same row would keep finding no sender.
    await dropToken(token);
    return settle('failed', 'no_sender', 'no_sender');
  }
  return (await retryReset(deps, row, 'delivery_failed')) ? 'retried' : settle('failed', 'delivery_failed', 'delivery_failed');
}

/**
 * One delivery round: cleanup, then claim and process due rows one at a time (so no row waits in
 * "sending" behind a long batch). Provider failures retry with backoff up to `RESET_MAX_ATTEMPTS`.
 */
export async function runPasswordResetDeliveriesOnce(
  deps: ResetDeliveryDeps,
  opts: { batch?: number; cleanup?: boolean } = {},
): Promise<ResetDeliverySummary> {
  const summary: ResetDeliverySummary = { handled: 0, sent: 0, failed: 0, skipped: 0, retried: 0, superseded: 0 };
  const send = deps.send ?? ((d, account, token, ttl) => sendPasswordResetEmail(d, account, token, ttl));
  if (opts.cleanup !== false) await cleanupResetQueue(deps);
  const batch = opts.batch ?? 25;
  for (let i = 0; i < batch; i++) {
    const row = await claimReset(deps);
    if (!row) break;
    summary.handled++;
    const result = await deliverReset(deps, row, send);
    summary[result]++;
  }
  return summary;
}

/** The worker loop: sends queued reset links until `signal` aborts. */
export async function runPasswordResetDeliveries(
  deps: ResetDeliveryDeps,
  signal: AbortSignal,
  opts: { tickMs?: number; batch?: number } = {},
) {
  const tickMs = opts.tickMs ?? 1000;
  let lastCleanup = 0;
  logger.info('worker role: password reset delivery');
  while (!signal.aborted) {
    let handled = 0;
    const cleanup = Date.now() - lastCleanup >= RESET_CLEANUP_INTERVAL_MS;
    if (cleanup) lastCleanup = Date.now();
    try {
      handled = (await runPasswordResetDeliveriesOnce(deps, { batch: opts.batch, cleanup })).handled;
    } catch (err) {
      logger.error({ err }, 'password reset delivery round failed');
    }
    if (signal.aborted) break;
    if (!handled)
      await delay(tickMs, undefined, { signal }).catch((err) => {
        if (!signal.aborted) throw err;
      });
  }
}

/**
 * Appends an audit entry for a reset request or completion (#191): person, IP and outcome, never
 * the token or the address. The audit log is per workspace, so the entry lands in the person's
 * oldest workspace; someone without one is only in the server log. The hash chain is kept like a
 * command's entry.
 *
 * `surface` says where the reset happened: `internal` for the web flow, `cli` for
 * `am reset-password` (#913), which has no client IP.
 */ export async function recordPasswordResetAudit(
  db: Db,
  entry: {
    userId: string | null;
    ip: string | null;
    command: 'auth.passwordResetRequest' | 'auth.passwordReset';
    outcome: ResetOutcome;
    surface?: 'internal' | 'cli';
  },
): Promise<void> {
  const userId = entry.userId;
  if (!userId) {
    logger.info({ command: entry.command, ip: entry.ip }, 'password reset event that cannot be attributed to an account');
    return;
  }
  try {
    const { rows } = await db.admin.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at, workspace_id LIMIT 1',
      [userId],
    );
    const workspaceId = rows[0]?.workspace_id;
    if (!workspaceId) {
      logger.info({ command: entry.command, userId, ip: entry.ip }, 'password reset event for a person without a workspace');
      return;
    }
    const ok = entry.outcome === 'ok' || entry.outcome === 'sent';
    // The shared append helper, so the entry is shaped (and hashed) exactly like every other audit
    // entry: an absent IP is omitted from the hash, which a hand-built entry got wrong (#913).
    // The principal is audit-only; no permission is evaluated when an entry is appended.
    const principal: Principal = { type: 'user', userId, workspaceId, role: 'viewer', permissions: new Set() };
    await db.withWorkspace(workspaceId, (tx) =>
      appendAuditEntry(
        tx,
        principal,
        entry.surface ?? 'internal',
        { name: entry.command, effect: 'write' },
        // What happened and from where, never the token or the password.
        sha256(`${entry.command}:${userId}:${entry.ip}:${entry.outcome}`),
        userId,
        ok ? undefined : { code: 'password_reset', message: entry.outcome },
        entry.ip,
      ),
    );
  } catch (err) {
    // An audit write must never break the flow; the request outcome is already logged above.
    logger.warn({ err, command: entry.command, userId }, 'could not append the password reset audit entry');
  }
}

/** What an operator-initiated reset needs; the two writes are seams for tests. */
export interface AdminResetDeps {
  db: Db;
  auth: Auth;
  /** Deletes every session of the person. Defaults to Better Auth's internal adapter. */
  revokeSessions?: (userId: string) => Promise<void>;
  /** Writes the new credential, updating the password account or linking one. Same default. */
  writeCredential?: (target: { userId: string; credentialId: string | null; hashed: string }) => Promise<void>;
}

/**
 * `am reset-password` (#913): set a new password and end every session of that person in **one**
 * transaction, so a crash between the two cannot leave a stolen cookie valid behind a password the
 * operator was told was updated. The order matches Better Auth's own reset (revoke, then write):
 * on an adapter without transactions the old password still stands rather than a new one shipping
 * next to live sessions. The audit entry is the one the web reset writes, marked `cli` because
 * there is no request and no client IP.
 */
export async function resetPasswordForEmail(deps: AdminResetDeps, email: string, password: string): Promise<{ userId: string }> {
  const context = await deps.auth.$context;
  const found = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (!found) throw new Error(`reset-password: no user with email ${email}`);
  const hashed = await context.password.hash(password);
  const credential = found.accounts.find((account) => account.providerId === 'credential');
  const revokeSessions = deps.revokeSessions ?? ((userId: string) => context.internalAdapter.deleteUserSessions(userId));
  const writeCredential =
    deps.writeCredential ??
    (async ({ userId, credentialId, hashed: passwordHash }: { userId: string; credentialId: string | null; hashed: string }) => {
      if (credentialId) await context.internalAdapter.updateAccount(credentialId, { password: passwordHash });
      else
        await context.internalAdapter.linkAccount({
          userId,
          providerId: 'credential',
          accountId: userId,
          password: passwordHash,
        });
    });
  await inAuthTransaction(deps.auth, async () => {
    await revokeSessions(found.user.id);
    await writeCredential({ userId: found.user.id, credentialId: credential?.id ?? null, hashed });
  });
  await recordPasswordResetAudit(deps.db, {
    userId: found.user.id,
    ip: null,
    command: 'auth.passwordReset',
    outcome: 'ok',
    surface: 'cli',
  });
  return { userId: found.user.id };
}
