import type { Purposes } from '@agentic-marketing/artifacts';
import { type ConsentSource, type ConsentStatus, schema, type Tx } from '@agentic-marketing/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

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

/**
 * Whether processing for a purpose is allowed for a person: consent needs a current "granted";
 * legitimate interest holds unless they objected or withdrew; contract and legal obligation hold.
 */
export function purposeAllowed(basis: string, status: ConsentStatus | undefined): boolean {
  if (basis === 'consent') return status === 'granted';
  if (basis === 'legitimate_interest') return status !== 'objected' && status !== 'withdrawn' && status !== 'denied';
  return true;
}
