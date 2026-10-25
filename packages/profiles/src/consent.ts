import type { Purposes } from '@agentic-marketing/artifacts';
import { type ConsentSource, type ConsentStatus, schema, type Tx } from '@agentic-marketing/db';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

// The consent and objection ledger (security-and-privacy.md §2). Records are append-only;
// consent_state is the latest record per purpose and channel, over a profile and every profile
// merged into it.

export interface ConsentInput {
  purpose: string;
  channel?: string;
  status: ConsentStatus;
  source: ConsentSource;
  proof?: Record<string, unknown>;
  messageId?: string;
  recordedBy?: string;
  recordedAt?: Date;
}

/** The profile and every profile merged into it, directly or through earlier merges. */
export async function mergedFamily(tx: Tx, workspaceId: string, profileId: string): Promise<string[]> {
  const res = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE fam(id) AS (
      SELECT ${profileId}::text
      UNION SELECT m.from_id FROM profile_merges m JOIN fam ON m.into_id = fam.id WHERE m.workspace_id = ${workspaceId}
    ) SELECT id FROM fam`);
  return res.rows.map((r) => r.id);
}

export function basisOf(purposes: Purposes, purpose: string) {
  return purposes.find((p) => p.key === purpose)?.basis ?? 'consent';
}

export async function recordConsent(tx: Tx, workspaceId: string, profileId: string, purposes: Purposes, records: ConsentInput[]) {
  if (!records.length) return 0;
  const inserted = await tx
    .insert(schema.consentRecords)
    .values(
      records.map((r) => ({
        workspaceId,
        profileId,
        purpose: r.purpose,
        channel: r.channel ?? '',
        status: r.status,
        basis: basisOf(purposes, r.purpose),
        source: r.source,
        proof: r.proof ?? {},
        messageId: r.messageId ?? null,
        recordedBy: r.recordedBy ?? null,
        recordedAt: r.recordedAt ?? new Date(),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.consentRecords.id });
  if (inserted.length) await recomputeConsentState(tx, workspaceId, profileId);
  return inserted.length;
}

export async function recomputeConsentState(tx: Tx, workspaceId: string, profileId: string) {
  const family = await mergedFamily(tx, workspaceId, profileId);
  await tx
    .delete(schema.consentState)
    .where(and(eq(schema.consentState.workspaceId, workspaceId), eq(schema.consentState.profileId, profileId)));
  await tx.execute(sql`
    INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
    SELECT DISTINCT ON (purpose, channel) workspace_id, ${profileId}, purpose, channel, status, basis, source, recorded_at
    FROM consent_records
    WHERE workspace_id = ${workspaceId} AND ${inArray(schema.consentRecords.profileId, family)}
    ORDER BY purpose, channel, recorded_at DESC, id DESC`);
}

export async function consentStateOf(tx: Tx, workspaceId: string, profileId: string) {
  return tx
    .select()
    .from(schema.consentState)
    .where(and(eq(schema.consentState.workspaceId, workspaceId), eq(schema.consentState.profileId, profileId)));
}

// The current status of a purpose (docs/architecture/adr/0014-consent-channel-precedence.md).
// consent_state holds one row per purpose and channel: '' is "all channels" (forms, imports,
// the SDK), a named channel comes from that channel (an unsubscribe link writes 'email'). Every
// reader asks the same question through currentConsent (JS) or consentStatusSql (SQL):
//
// - For a channel C: the newest of the '' row and the C row.
// - Without a channel (segments, audience syncs, webhooks, AI): the '' row, unless a channel row
//   is at least as new as it; then a refusal on any channel wins over a grant, newest first.
//
// Equal timestamps resolve to the refusal. Without a channel, a channel-specific grant never
// lifts an all-channels refusal; it only counts for that channel's own sends.

export const REFUSALS: readonly ConsentStatus[] = ['withdrawn', 'objected', 'denied'];
const refusal = (s: string) => (REFUSALS as readonly string[]).includes(s);

export interface ConsentRow {
  purpose: string;
  channel: string;
  status: ConsentStatus;
  updatedAt: Date;
}

/** The row that decides a purpose's current status, for one channel or (without one) for the person. */
export function currentConsent<T extends ConsentRow>(rows: T[], purpose: string, channel?: string): T | undefined {
  const own = rows.filter((r) => r.purpose === purpose);
  const newest = (a: T, b: T) => b.updatedAt.getTime() - a.updatedAt.getTime();
  const refusalFirst = (a: T, b: T) => Number(refusal(b.status)) - Number(refusal(a.status));
  if (channel) return own.filter((r) => r.channel === '' || r.channel === channel).sort((a, b) => newest(a, b) || refusalFirst(a, b))[0];
  const all = own.find((r) => r.channel === '');
  return own
    .filter((r) => r.channel === '' || !all || r.updatedAt.getTime() >= all.updatedAt.getTime())
    .sort((a, b) => refusalFirst(a, b) || newest(a, b))[0];
}

/**
 * currentConsent as a scalar SQL subquery: the status (or NULL) for the person whose profile id
 * `profileId` evaluates to. Reads consent_state under the workspace's row policy.
 */
export function consentStatusSql(profileId: SQL, purpose: string, channel?: string): SQL {
  const isRefusal = sql`(c.status IN ('withdrawn', 'objected', 'denied'))`;
  if (channel)
    return sql`(SELECT c.status FROM consent_state c WHERE c.profile_id = ${profileId} AND c.purpose = ${purpose}
      AND c.channel IN ('', ${channel}) ORDER BY c.updated_at DESC, ${isRefusal} DESC LIMIT 1)`;
  return sql`(SELECT c.status FROM consent_state c WHERE c.profile_id = ${profileId} AND c.purpose = ${purpose}
      AND (c.channel = '' OR c.updated_at >= coalesce((SELECT a.updated_at FROM consent_state a
        WHERE a.profile_id = c.profile_id AND a.purpose = c.purpose AND a.channel = ''), '-infinity'::timestamptz))
    ORDER BY ${isRefusal} DESC, c.updated_at DESC LIMIT 1)`;
}

/** purposeAllowed in SQL, over a status expression such as consentStatusSql (never NULL). */
export function purposeAllowedSql(basis: string, status: SQL): SQL {
  if (basis === 'consent') return sql`coalesce(${status} = 'granted', false)`;
  if (basis === 'legitimate_interest') return sql`coalesce(${status} NOT IN ('withdrawn', 'objected', 'denied'), true)`;
  return sql`true`;
}

/**
 * Whether processing for a purpose is allowed for a person: consent needs a current "granted";
 * legitimate interest holds unless they objected or withdrew; contract and legal obligation hold.
 */
export function purposeAllowed(basis: string, status: ConsentStatus | undefined): boolean {
  if (basis === 'consent') return status === 'granted';
  if (basis === 'legitimate_interest') return status !== 'objected' && status !== 'withdrawn' && status !== 'denied';
  return true;
}
