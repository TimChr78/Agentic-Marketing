import { canonicalProfileId, DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { redact } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { consentStateOf, currentConsent, personCrypto, purposeAllowed } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, eq } from 'drizzle-orm';

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

/** Whether the person's data may be processed by AI (the ai_processing purpose and its basis). */
export async function aiAllowed(tx: Tx, workspaceId: string, profileId: string): Promise<{ ok: boolean; reason?: string }> {
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const p = purposes.find((x) => x.key === AI_PURPOSE);
  if (!p) return { ok: false, reason: `no_lawful_basis: the ${AI_PURPOSE} purpose is not configured` };
  const state = currentConsent(await consentStateOf(tx, workspaceId, profileId), AI_PURPOSE);
  if (purposeAllowed(p.basis, state?.status)) return { ok: true };
  return {
    ok: false,
    reason: `no_lawful_basis: ${AI_PURPOSE} is based on ${p.basis.replace('_', ' ')} and the person's status is ${state?.status ?? 'unknown (no record)'}`,
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
