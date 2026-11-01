import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { consentStateOf, currentConsent, personCrypto, purposeAllowed } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, eq } from 'drizzle-orm';

// The context builder (agents-and-mcp.md §5): what a model may know about a person. Only
// non-personal traits and personal traits the tracking plan marks agentVisible, the profile id
// instead of any identifier, and recent events with free text scrubbed of contact details.

export const AI_PURPOSE = 'ai_processing';

export interface PersonContext {
  id: string;
  traits: Record<string, unknown>;
  recentEvents: { name: string; at: string; properties: Record<string, unknown> }[];
  trigger?: { name: string; properties: Record<string, unknown> };
}

const detectors: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, '[iban]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  [/(?:\+|\b00)\d[\d ().-]{6,}\d\b/g, '[phone]'],
  [/\b\d{6}-?\d{4}\b/g, '[national-id]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
];

/** Rule-based redaction of contact and payment details in free text. */
export function redactText(s: string): string {
  let out = s;
  for (const [re, label] of detectors) out = out.replace(re, label);
  return out;
}

/** Which kinds of personal data the same detectors find in free text, e.g. ["[email]"]. */
export function personalDataIn(s: string): string[] {
  const found = new Set<string>();
  for (const [re, label] of detectors) {
    re.lastIndex = 0;
    if (re.test(s)) found.add(label);
    re.lastIndex = 0;
  }
  return [...found];
}

export function redact<T>(v: T, depth = 0): T {
  if (typeof v === 'string') return redactText(v) as T;
  if (depth > 5 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1)) as T;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redact(x, depth + 1)])) as T;
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
  const recent = await events
    .eventsOf(
      workspaceId,
      {
        anonymousIds: ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
        userIds: ids.filter((i) => i.type === 'user_id').map((i) => i.value),
      },
      { limit: 20 },
    )
    .catch(() => []);
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
