import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { hashedResetTokenIdentifier } from '@agentic-marketing/auth';
import { canonicalJson, newId, sha256 } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import { openJson, sealJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { desc, eq, sql } from 'drizzle-orm';

// Self-service password reset (#191), the server side of Better Auth's reset flow:
//
//   request → rate limit → account checks → token + mail through a transactional provider
//   reset   → rate limit → token lookup (for the audit entry) → Better Auth sets the password
//           and revokes every session of that person.
//
// The flow is installation-level: the link points at PUBLIC_URL, never at a brand's domain. A
// person who belongs to several workspaces gets one link, sent through the transactional provider
// of their oldest workspace, so the sender is one they belong to and never a stranger's brand.

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
  | 'no_password'
  | 'sso_only'
  | 'no_sender'
  | 'delivery_failed'
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

/** The user id a still-valid reset token belongs to, or null. Reads the token's hashed identifier. */
export async function resetTokenAccount(db: Db, token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  const { rows } = await db.admin.query<{ value: string }>(
    'SELECT value FROM "verification" WHERE identifier = $1 AND "expiresAt" > now() LIMIT 1',
    [hashedResetTokenIdentifier(token)],
  );
  return rows[0] ? { userId: rows[0].value } : null;
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
    logger.warn({ userId: account.id, workspaceId, error: result?.error }, 'password reset e-mail could not be sent');
    return 'failed';
  } catch (err) {
    logger.warn({ err, userId: account.id }, 'password reset e-mail could not be sent');
    return 'failed';
  }
}

/** How many deliveries one queued reset gets before it is recorded failed (bounded queue). */
export const RESET_MAX_ATTEMPTS = 4;
/** Transactional backoff between provider retries, in seconds (the e-mail outbox's own scale). */
const RESET_RETRY_SECONDS = [10, 30, 60, 120] as const;
/**
 * A worker that stopped mid-send leaves the row "sending". The token is the same, so it is retried
 * after this window rather than failed: a duplicate reset mail is harmless, a lost one is not.
 */
const RESET_STALE_SENDING_SECONDS = 600;
/** Settled rows are kept for operator visibility, then pruned by the worker. */
const RESET_SETTLED_RETENTION_DAYS = 7;

export interface ResetQueueDeps extends NotifyDeps {
  db: Db;
  /** Admin UI base URL; the reset page lives at `${publicUrl}/reset-password`. */
  publicUrl: string;
  /** The token lifetime, used in the mail's expiry text. */
  ttlSeconds: number;
}

export interface ResetDeliveryDeps extends ResetQueueDeps {
  /** Test seam for the provider call; defaults to `sendPasswordResetEmail`. */
  send?: (deps: ResetQueueDeps, account: ResetAccount, token: string, ttlSeconds: number) => Promise<'sent' | 'no_sender' | 'failed'>;
}

/**
 * Records a reset link for the delivery worker and returns without touching a mail provider
 * (#379). The request's answer is then independent of provider latency and of the account class.
 */
export async function queueResetLink(
  deps: ResetQueueDeps,
  account: ResetAccount,
  token: string,
  ip: string,
): Promise<'queued' | 'sso_only' | 'no_password' | 'no_sender' | 'failed'> {
  const eligibility = await resetEligibility(deps.db, account);
  if (eligibility !== 'ok') {
    // Another path reached Better Auth's callback for someone this flow never mails.
    await recordPasswordResetAudit(deps.db, { userId: account.id, ip, command: 'auth.passwordResetRequest', outcome: eligibility });
    return eligibility;
  }
  const workspaceId = await senderWorkspaceFor(deps.db, account.id);
  if (!workspaceId) {
    logger.warn(
      { userId: account.id },
      'password reset requested but no workspace of this person has an enabled transactional e-mail provider; configure one, or use `am reset-password --email …`',
    );
    await recordPasswordResetAudit(deps.db, { userId: account.id, ip, command: 'auth.passwordResetRequest', outcome: 'no_sender' });
    return 'no_sender';
  }
  try {
    // The queue is the only place besides Better Auth's hashed row that knows the token, and here
    // it is sealed with the sender workspace's data key. It is wiped when the row settles.
    await deps.db.withWorkspace(workspaceId, async (tx) => {
      const sealed = await sealJson(tx, workspaceId, deps.kp, { token });
      await tx.insert(schema.passwordResetDeliveries).values({
        id: newId('prd'),
        userId: account.id,
        workspaceId,
        ip,
        tokenSealed: sealed.blob,
        tokenKeyId: sealed.keyId,
      });
    });
    return 'queued';
  } catch (err) {
    logger.warn({ err, userId: account.id }, 'password reset link could not be queued');
    await recordPasswordResetAudit(deps.db, { userId: account.id, ip, command: 'auth.passwordResetRequest', outcome: 'delivery_failed' });
    return 'failed';
  }
}

interface QueuedResetRow {
  id: string;
  user_id: string;
  workspace_id: string;
  ip: string;
  token_sealed: Buffer | null;
  token_key_id: string | null;
  attempts: number;
}

export interface ResetDeliverySummary {
  /** Rows claimed in this round. */
  handled: number;
  sent: number;
  /** Terminal failures, including a provider that kept failing. */
  failed: number;
  /** Provider failures left queued for another attempt. */
  retried: number;
}

/** Wipes the token and records the terminal outcome; the row stays for operators, bounded by retention. */
async function settleReset(
  deps: ResetQueueDeps,
  row: QueuedResetRow,
  status: 'sent' | 'failed',
  outcome: ResetOutcome,
  error: string | null,
) {
  await deps.db.admin.query(
    `UPDATE password_reset_deliveries
        SET status = $2, last_error = $3, token_sealed = NULL, token_key_id = NULL,
            next_attempt_at = NULL, updated_at = now()
      WHERE id = $1`,
    [row.id, status, error],
  );
  await recordPasswordResetAudit(deps.db, { userId: row.user_id, ip: row.ip, command: 'auth.passwordResetRequest', outcome });
}

/**
 * One delivery round: claims due rows, reopens rows a stopped worker left "sending", sends and
 * records the outcome. Provider failures retry with backoff up to `RESET_MAX_ATTEMPTS`.
 */
export async function runPasswordResetDeliveriesOnce(
  deps: ResetDeliveryDeps,
  opts: { batch?: number } = {},
): Promise<ResetDeliverySummary> {
  const summary: ResetDeliverySummary = { handled: 0, sent: 0, failed: 0, retried: 0 };
  const send = deps.send ?? ((d, account, token, ttl) => sendPasswordResetEmail(d, account, token, ttl));
  // A settled row's evidence is only the outcome; keeping it longer than this is a leak, not an audit.
  await deps.db.admin.query(
    `DELETE FROM password_reset_deliveries
      WHERE status IN ('sent', 'failed') AND updated_at < now() - make_interval(days => $1)`,
    [RESET_SETTLED_RETENTION_DAYS],
  );
  await deps.db.admin.query(
    `UPDATE password_reset_deliveries
        SET status = 'queued', last_error = coalesce(last_error, 'worker stopped while sending'), updated_at = now()
      WHERE status = 'sending' AND updated_at < now() - make_interval(secs => $1)`,
    [RESET_STALE_SENDING_SECONDS],
  );
  const { rows } = await deps.db.admin.query<QueuedResetRow>(
    `UPDATE password_reset_deliveries
        SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM password_reset_deliveries
         WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, workspace_id, ip, token_sealed, token_key_id, attempts`,
    [opts.batch ?? 25],
  );
  for (const row of rows) {
    summary.handled++;
    const failed = async (reason: string, permanent = true) => {
      if (!permanent && row.attempts < RESET_MAX_ATTEMPTS) {
        const delay = RESET_RETRY_SECONDS[row.attempts - 1] ?? 120;
        await deps.db.admin.query(
          `UPDATE password_reset_deliveries
              SET status = 'queued', last_error = $2, next_attempt_at = now() + make_interval(secs => $3), updated_at = now()
            WHERE id = $1`,
          [row.id, reason, delay],
        );
        summary.retried++;
        return;
      }
      summary.failed++;
      await settleReset(deps, row, 'failed', 'delivery_failed', reason);
    };
    if (!row.token_sealed || !row.token_key_id) {
      await failed('token_missing: the queued link has no token');
      continue;
    }
    let token: string;
    try {
      token = (
        await deps.db.withWorkspace(row.workspace_id, (tx) =>
          openJson<{ token: string }>(tx, row.workspace_id, deps.kp, row.token_sealed!, row.token_key_id!),
        )
      ).token;
    } catch (err) {
      logger.warn({ err, id: row.id }, 'queued password reset link could not be opened');
      await failed('token_unreadable: the sealed link could not be opened');
      continue;
    }
    const { rows: people } = await deps.db.admin.query<ResetAccount>('SELECT id, email, name FROM "user" WHERE id = $1', [row.user_id]);
    const account = people[0];
    if (!account) {
      await failed('account_gone: the account no longer exists');
      continue;
    }
    let result: 'sent' | 'no_sender' | 'failed';
    try {
      result = await send(deps, account, token, deps.ttlSeconds);
    } catch (err) {
      logger.warn({ err, id: row.id }, 'password reset delivery threw');
      result = 'failed';
    }
    if (result === 'sent') {
      summary.sent++;
      await settleReset(deps, row, 'sent', 'sent', null);
    } else if (result === 'no_sender') {
      // Configuration is not a transient provider error: the same row would keep finding no sender.
      await failed('no_sender: no enabled transactional e-mail provider');
    } else {
      await failed('delivery_failed: the provider did not accept the message', false);
    }
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
  logger.info('worker role: password reset delivery');
  while (!signal.aborted) {
    let handled = 0;
    try {
      handled = (await runPasswordResetDeliveriesOnce(deps, opts)).handled;
    } catch (err) {
      logger.error({ err }, 'password reset delivery round failed');
    }
    if (signal.aborted) break;
    if (!handled)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, tickMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
  }
}

/**
 * Appends an audit entry for a reset request or completion (#191): person, IP and outcome, never
 * the token. The audit log is per workspace, so the entry lands in the person's oldest workspace;
 * someone without one is only in the server log. The hash chain is kept like a command's entry.
 */ export async function recordPasswordResetAudit(
  db: Db,
  entry: { userId: string | null; ip: string; command: 'auth.passwordResetRequest' | 'auth.passwordReset'; outcome: ResetOutcome },
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
    await db.withWorkspace(workspaceId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${workspaceId}`}, 0))`);
      const [previous] = await tx
        .select({ hash: schema.auditLog.hash })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.workspaceId, workspaceId))
        .orderBy(desc(schema.auditLog.seq))
        .limit(1);
      const row = {
        workspaceId,
        principalType: 'user',
        principalId: userId,
        clientId: null,
        surface: 'internal',
        command: entry.command,
        effect: 'write',
        target: userId,
        // What happened and from where, never the token or the password.
        inputHash: sha256(`${entry.command}:${userId}:${entry.ip}:${entry.outcome}`),
        ok: entry.outcome === 'ok' || entry.outcome === 'sent',
        error: entry.outcome === 'ok' || entry.outcome === 'sent' ? null : `password_reset: ${entry.outcome}`,
        prevHash: previous?.hash ?? null,
        ip: entry.ip,
      };
      await tx.insert(schema.auditLog).values({ ...row, hash: sha256(canonicalJson(row)) });
    });
  } catch (err) {
    // An audit write must never break the flow; the request outcome is already logged above.
    logger.warn({ err, command: entry.command, userId }, 'could not append the password reset audit entry');
  }
}
