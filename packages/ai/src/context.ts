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

/** Which kinds of personal data the same detectors find in free text, e.g. ["[email]"] (hosted memory notes, #340). */
export function personalDataInText(s: string): string[] {
  const found = new Set<string>();
  for (const [re, label] of detectors) {
    re.lastIndex = 0;
    if (re.test(s)) found.add(label);
    re.lastIndex = 0;
  }
  return [...found];
}

/** Markers for what a structural cap removed: a marker, never the original value. */
export const REDACTED_CYCLE = '[redacted: circular]';
export const REDACTED_LIMIT = '[redacted: too large]';

/** Arrays kept their original cap; objects and the whole walk get their own, larger ones. */
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 1_000;
const MAX_NODES = 10_000;

/**
 * Rule-based redaction of contact and payment details at every depth (#641). Walks iteratively
 * with no depth cap, the way `personalDataIn` does (#352), so a value nested fifty levels down
 * is still visited instead of returned unchanged. A cycle or a size cap fails closed: the part
 * that cannot be visited becomes a marker, never the original value.
 */
export function redact<T>(input: T): T {
  let result: unknown;
  const seen = new WeakSet<object>();
  type Job = { value: unknown; set: (out: unknown) => void };
  const jobs: Job[] = [
    {
      value: input,
      set: (out) => {
        result = out;
      },
    },
  ];
  let nodes = 0;
  while (jobs.length) {
    const job = jobs.pop();
    if (!job) break;
    const { value, set } = job;
    if (typeof value === 'string') {
      set(redactText(value));
      continue;
    }
    if (value === null || typeof value !== 'object') {
      set(value);
      continue;
    }
    // A cycle (or a value already seen) cannot be walked safely and must not be forwarded.
    if (seen.has(value)) {
      set(REDACTED_CYCLE);
      continue;
    }
    seen.add(value);
    if (++nodes > MAX_NODES) {
      set(REDACTED_LIMIT);
      continue;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      set(out);
      const kept = Math.min(value.length, MAX_ARRAY_ITEMS);
      for (let i = 0; i < kept; i++) {
        out.push(undefined);
        jobs.push({
          value: value[i],
          set: (x) => {
            out[i] = x;
          },
        });
      }
      if (value.length > kept) out.push(REDACTED_LIMIT);
      continue;
    }
    const out: Record<string, unknown> = {};
    set(out);
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = Math.min(entries.length, MAX_OBJECT_KEYS);
    for (let i = 0; i < kept; i++) {
      const [k, x] = entries[i] as [string, unknown];
      out[k] = undefined;
      jobs.push({
        value: x,
        set: (y) => {
          out[k] = y;
        },
      });
    }
    if (entries.length > kept) out[REDACTED_LIMIT] = REDACTED_LIMIT;
  }
  return result as T;
}

/** Keys whose name alone marks personal data, even when the value does not match a detector. */
const PERSONAL_KEY =
  /^(e-?mail|phone|mobile|msisdn|first_?name|last_?name|full_?name|name|address|street|postcode|zip|ssn|iban|card(_?number)?)$/i;

/**
 * The kind of personal data in a value ("email", "phone", …), or null. Uses the same detectors
 * as `redact`, so a decision provider without a no-retention agreement can refuse a state
 * instead of sending it (#194).
 */
export function personalDataIn(v: unknown): string | null {
  // Iterative, with no depth cap: a value nested deeper than the old limit of 8 used to be
  // skipped entirely, so an e-mail nine levels down reached the provider (#352). The stack also
  // keeps a deeply nested value from overflowing the call stack.
  const stack: unknown[] = [v];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'string') {
      for (const [re, label] of detectors) {
        re.lastIndex = 0;
        if (re.test(x)) return label.replace(/[[\]]/g, '');
      }
      continue;
    }
    if (x === null || typeof x !== 'object') continue;
    if (seen.has(x)) continue;
    seen.add(x);
    if (Array.isArray(x)) {
      for (const item of x) stack.push(item);
      continue;
    }
    for (const [k, item] of Object.entries(x as Record<string, unknown>)) {
      if (PERSONAL_KEY.test(k)) return 'identifier';
      stack.push(item);
    }
  }
  return null;
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
