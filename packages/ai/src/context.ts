import { canonicalProfileId, DEFAULT_PURPOSES, mergeComponentCtes, publishedSingleton } from '@agentic-marketing/artifacts';
import { redact } from '@agentic-marketing/core';
import { type ConsentStatus, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { consentStatusSql, personCrypto, purposeAllowed } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, eq, sql } from 'drizzle-orm';

// The context builder (agents-and-mcp.md §5): what a model may know about a person. Only
// non-personal traits and personal traits the tracking plan marks agentVisible, the profile id
// instead of any identifier, and recent events with free text scrubbed of contact details.

// Re-exported from core, where the consent ledger also uses the same detectors.
export {
  personalDataIn,
  personalDataInText,
  REDACTED_CYCLE,
  REDACTED_LIMIT,
  redact,
  redactText,
} from '@agentic-marketing/core';

export const AI_PURPOSE = 'ai_processing';

export interface PersonContext {
  id: string;
  traits: Record<string, unknown>;
  recentEvents: { name: string; at: string; properties: Record<string, unknown> }[];
  trigger?: { name: string; properties: Record<string, unknown> };
}

/**
 * The gate's answer: allowed for the person `profileId` names today, or why not. A refusal carries
 * the canonical id it answered for (null when the id names no person), so a caller can tell a
 * stable refusal from a person who moved and does not ask again.
 */
export type AiConsent = { ok: true; profileId: string } | { ok: false; reason: string; profileId: string | null };

const NO_PROFILE = 'no_profile: the person does not exist (or was erased)';

/**
 * Whether the person's data may be processed by AI (the ai_processing purpose and its basis).
 *
 * A merge deletes the merged-away profile's consent_state rows, so an id a caller holds from
 * before the merge reads "no record": allowed on a legitimate-interest purpose even when the
 * person objected, and refused on a consent basis even when they granted. Answer for the person
 * the id names today, and return that canonical id so the gate and the work it allows use the
 * same profile.
 *
 * The canonical id and the consent status come from one statement: a second read can straddle a
 * merge that changes the survivor's effective consent while its id stays the same, which comparing
 * the ids of two lookups cannot detect.
 */
export async function aiAllowed(tx: Tx, workspaceId: string, profileId: string): Promise<AiConsent> {
  const { rows } = await tx.execute<{ id: string | null; merged_into: string | null; status: ConsentStatus | null }>(sql`
    WITH RECURSIVE ${mergeComponentCtes(workspaceId, { seeds: sql`SELECT ${profileId}::text AS id` })}
    SELECT p.id, p.merged_into, ${consentStatusSql(sql`p.id`, AI_PURPOSE)} AS status
    FROM merge_representative mr
    LEFT JOIN profiles p ON p.workspace_id = ${workspaceId} AND p.id = mr.representative COLLATE "default"
    WHERE mr.origin = ${profileId}::text`);
  const person = rows[0];
  if (!person || person.id === null || person.merged_into !== null) return { ok: false, reason: NO_PROFILE, profileId: null };
  const canonical = person.id;
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const p = purposes.find((x) => x.key === AI_PURPOSE);
  if (!p) return { ok: false, reason: `no_lawful_basis: the ${AI_PURPOSE} purpose is not configured`, profileId: canonical };
  if (purposeAllowed(p.basis, person.status ?? undefined)) return { ok: true, profileId: canonical };
  return {
    ok: false,
    reason: `no_lawful_basis: ${AI_PURPOSE} is based on ${p.basis.replace('_', ' ')} and the person's status is ${person.status ?? 'unknown (no record)'}`,
    profileId: canonical,
  };
}

export interface ProfilePreparation<T> {
  /** The canonical person the preparation ran for; null when the reference has no person. */
  profileId: string | null;
  result: T;
}

/**
 * Runs `prepare` for the person `reference` points at today, then re-resolves the person and runs it
 * again when a merge moved them during preparation (#1269 review). The consent lookup and the state
 * are read under one canonical id, so a merge that commits just before the consent lookup cannot
 * make the survivor's consent look absent (`no_lawful_basis`). `prepare` receives `undefined` on the
 * first run (resolve the reference itself), the new canonical id on a retry, and `null` when the
 * person disappeared. Preparation is bounded: a family that keeps merging past the bound returns
 * the last result rather than looping.
 */
export async function prepareWithCanonicalProfile<T>(
  tx: Tx,
  workspaceId: string,
  reference: string | null,
  prepare: (profileId: string | null | undefined) => Promise<ProfilePreparation<T>>,
  attempts = 3,
): Promise<ProfilePreparation<T>> {
  let prepared = await prepare(undefined);
  if (!reference) return prepared;
  for (let attempt = 1; attempt < attempts; attempt++) {
    const current = await canonicalProfileId(tx, workspaceId, reference);
    if (current === prepared.profileId) return prepared;
    prepared = await prepare(current);
  }
  return prepared;
}

export async function personContext(
  tx: Tx,
  workspaceId: string,
  kp: KeyProvider,
  events: EventStore,
  profileId: string,
  trigger?: { name: string; properties: Record<string, unknown> },
): Promise<PersonContext | null> {
  const [p] = await tx
    .select()
    .from(schema.profiles)
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, profileId)));
  if (!p) return null;
  const plan = await publishedSingleton(tx, 'tracking_plan');
  const visible = new Set(plan?.traits.filter((t) => t.agentVisible && t.pii !== 'sensitive').map((t) => t.name));
  const traits: Record<string, unknown> = { ...p.traits };
  if (visible.size) {
    const pii = (await personCrypto(tx, workspaceId, kp).open<Record<string, unknown>>(p.id, p.pii)) ?? {};
    for (const [k, v] of Object.entries(pii)) if (visible.has(k) && k !== 'email' && k !== 'phone') traits[k] = v;
  }
  const ids = await tx
    .select({ type: schema.identifiers.type, value: schema.identifiers.value })
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.workspaceId, workspaceId), eq(schema.identifiers.profileId, p.id)));
  const recent = await events.eventsOf(
    workspaceId,
    {
      anonymousIds: ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
      userIds: ids.filter((i) => i.type === 'user_id').map((i) => i.value),
    },
    { limit: 20 },
  );
  return redact({
    id: p.id,
    traits,
    recentEvents: recent
      .filter((e) => e.name)
      .reverse()
      .map((e) => ({ name: e.name, at: e.timestamp, properties: e.properties })),
    ...(trigger ? { trigger } : {}),
  });
}
