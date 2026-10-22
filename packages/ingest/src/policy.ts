import { DEFAULT_PURPOSES, type Purposes, type TrackingPlan } from '@agentic-marketing/artifacts';
import { type BusEvent, CONSENT_EVENT, consentOf, correctedTimestamp, eventName, type InboundEvent } from '@agentic-marketing/events';

// What ingest does to one event, as pure functions: consent gate, tracking plan, and keeping
// personal data out of the event store. The gateway feeds them; tests call them directly.

export interface SourceInfo {
  id: string;
  workspaceId: string;
  kind: 'browser' | 'server';
  requiredPurpose: string | null;
}

export interface WorkspacePolicy {
  plan: TrackingPlan | null;
  purposes: Purposes;
}

export const defaultPolicy: WorkspacePolicy = { plan: null, purposes: DEFAULT_PURPOSES };

/** Segment reserved traits that are personal data unless the attribute schema says otherwise. */
const PERSONAL_TRAITS = new Set([
  'email',
  'phone',
  'name',
  'firstName',
  'lastName',
  'first_name',
  'last_name',
  'address',
  'birthday',
  'username',
  'avatar',
]);

export type TraitClass = 'none' | 'personal' | 'sensitive' | 'drop';

export function traitClass(plan: TrackingPlan | null, name: string): TraitClass {
  const t = plan?.traits.find((x) => x.name === name);
  if (t) return t.pii;
  if (PERSONAL_TRAITS.has(name)) return 'personal';
  return plan?.unknownTraits === 'drop' ? 'drop' : 'none';
}

export function splitTraits(plan: TrackingPlan | null, traits: Record<string, unknown> | undefined) {
  const plain: Record<string, unknown> = {};
  const pii: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(traits ?? {})) {
    const c = traitClass(plan, k);
    if (c === 'none') plain[k] = v;
    else if (c !== 'drop') pii[k] = v;
  }
  return { plain, pii };
}

/** IPv4 to /24, IPv6 to /48: enough for coarse geo, not enough to identify a household. */
export function truncateIp(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0` : '';
}

const typeOk = (type: string, v: unknown) =>
  type === 'any' ||
  (type === 'array' ? Array.isArray(v) : type === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : typeof v === type);

export type Outcome =
  | { kind: 'accepted'; event: BusEvent; warnings: string[] }
  | { kind: 'dropped'; reason: 'no_consent' }
  | { kind: 'rejected'; error: string };

/** Whether the sender's consent signal allows keeping the event for the source's purpose. */
export function consentAllows(source: SourceInfo, policy: WorkspacePolicy, consent: Record<string, boolean> | undefined) {
  if (!source.requiredPurpose) return true;
  const purpose = policy.purposes.find((p) => p.key === source.requiredPurpose);
  const signal = consent?.[source.requiredPurpose];
  // Consent (or an unknown purpose) needs an explicit yes; other bases hold unless the visitor objected.
  if (!purpose || purpose.basis === 'consent') return signal === true;
  return signal !== false;
}

export function processEvent(
  e: InboundEvent,
  source: SourceInfo,
  policy: WorkspacePolicy,
  receivedAt: Date,
  opts: { ip?: string; messageId: () => string },
): Outcome {
  const warnings: string[] = [];
  const consent = consentOf(e.context);
  const name = eventName(e);
  const isConsentChange = e.type === 'track' && e.event === CONSENT_EVENT;

  // A consent change is always recorded (also a "no"); nothing else is without the purpose allowed.
  if (!isConsentChange && !consentAllows(source, policy, consent)) return { kind: 'dropped', reason: 'no_consent' };

  let properties: Record<string, unknown> = 'properties' in e ? { ...(e.properties ?? {}) } : {};
  const plan = policy.plan;
  if (plan && !isConsentChange && (e.type === 'track' || e.type === 'page' || e.type === 'screen')) {
    const def = plan.events.find((d) => d.name === name);
    if (!def) {
      if (plan.unknownEvents === 'block') return { kind: 'rejected', error: `Event "${name}" is not in the tracking plan.` };
      if (plan.unknownEvents === 'warn') warnings.push(`Event "${name}" is not in the tracking plan.`);
    } else {
      const problems: string[] = [];
      for (const p of def.properties) {
        const v = properties[p.name];
        if (v === undefined) {
          if (p.required) problems.push(`"${p.name}" is required`);
        } else if (!typeOk(p.type, v)) problems.push(`"${p.name}" should be ${p.type}`);
        if (p.pii) delete properties[p.name];
      }
      const unknown = Object.keys(properties).filter((k) => !def.properties.some((p) => p.name === k));
      if (unknown.length && plan.unknownProperties !== 'allow') {
        const msg = `Properties not in the tracking plan for "${name}": ${unknown.join(', ')}`;
        if (plan.unknownProperties === 'block') return { kind: 'rejected', error: msg };
        warnings.push(msg);
      }
      if (problems.length) {
        const msg = `"${name}": ${problems.join('; ')}`;
        if (plan.unknownProperties === 'block' || plan.unknownEvents === 'block') return { kind: 'rejected', error: msg };
        warnings.push(msg);
      }
    }
  }

  const context: Record<string, unknown> = { ...(e.context ?? {}) };
  const traitSource = e.type === 'identify' ? e.traits : (context.traits as Record<string, unknown> | undefined);
  delete context.traits;
  const { plain, pii } = e.type === 'group' ? { plain: e.traits ?? {}, pii: {} } : splitTraits(plan, traitSource);
  const ip = (context.ip as string | undefined) ?? opts.ip;
  if (ip) context.ip = truncateIp(ip);
  else delete context.ip;
  if (isConsentChange) properties = {};

  const event: BusEvent = {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    messageId: e.messageId ?? opts.messageId(),
    type: e.type,
    name,
    anonymousId: e.anonymousId ?? '',
    userId: e.userId ?? '',
    timestamp: correctedTimestamp(e, receivedAt).toISOString(),
    receivedAt: receivedAt.toISOString(),
    properties,
    traits: plain,
    piiTraits: pii,
    context,
    consent: consent ?? {},
    ...(e.type === 'alias' ? { previousId: e.previousId } : {}),
    ...(e.type === 'group' ? { groupId: e.groupId } : {}),
  };
  return { kind: 'accepted', event, warnings };
}
