import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { hashedResetTokenIdentifier } from '@agentic-marketing/auth';
import { canonicalJson, sha256 } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
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

export interface ResetDeliveryDeps extends NotifyDeps {
  db: Db;
  /** Admin UI base URL; the reset page lives at `${publicUrl}/reset-password`. */
  publicUrl: string;
}

/**
 * Sends the reset link through the person's transactional provider, recording it in that
 * workspace's message log. Never throws: the caller answers neutrally either way.
 */
export async function sendPasswordResetEmail(
  deps: ResetDeliveryDeps,
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

/**
 * Appends an audit entry for a reset request or completion (#191): person, IP and outcome, never
 * the token. The audit log is per workspace, so the entry lands in the person's oldest workspace;
 * someone without one is only in the server log. The hash chain is kept like a command's entry.
 */
export async function recordPasswordResetAudit(
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
