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

/**
 * The carrier events the platform emits itself through the ingest path: signup, confirmation,
 * import and the e-mail outcomes derived from the message log. They are not an operator's product
 * analytics, so a workspace tracking plan must not reject them (#624). Only a trusted internal
 * caller may claim this exemption (see `acceptInternalItems`); a public `/v1` client that happens
 * to send one of these names is still validated like any other event.
 */
export const PLATFORM_EVENT = {
  formSubmitted: 'Form Submitted',
  subscriptionConfirmed: 'Subscription Confirmed',
  subscriptionImported: 'Subscription Imported',
  emailSent: 'Email Sent',
  emailDelivered: 'Email Delivered',
  emailBounced: 'Email Bounced',
  emailComplained: 'Email Complained',
  emailLinkClicked: 'Email Link Clicked',
  emailUnsubscribed: 'Email Unsubscribed',
} as const;

/** Every platform-owned carrier event name, in one list for the ingest exemption. */
export const PLATFORM_EVENTS: readonly string[] = Object.values(PLATFORM_EVENT);
const PLATFORM_EVENT_SET = new Set(PLATFORM_EVENTS);

export const isPlatformEvent = (name: string) => PLATFORM_EVENT_SET.has(name);

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

/**
 * Segment reserved property names that are personal data. They are removed from every accepted
 * unclassified event. A published plan may explicitly classify a property as non-personal.
 */
const PERSONAL_PROPERTIES = new Set([
  'email',
  'email_address',
  'phone',
  'phone_number',
  'name',
  'full_name',
  'firstName',
  'lastName',
  'first_name',
  'last_name',
  'address',
  'street',
  'streetAddress',
  'street_address',
  'postalCode',
  'postal_code',
  'zip',
  'zipCode',
  'zip_code',
  'birthday',
  'dateOfBirth',
  'date_of_birth',
  'username',
  'avatar',
  'ip',
  'ipAddress',
  'ip_address',
]);

/** Top-level reserved personal keys only: nested objects keep their metrics (e.g. products[].name). */
function redactReservedProperties(properties: Record<string, unknown>, nonPersonal: Set<string>) {
  for (const key of Object.keys(properties)) if (PERSONAL_PROPERTIES.has(key) && !nonPersonal.has(key)) delete properties[key];
}

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
  opts: { ip?: string; messageId: () => string; internal?: boolean },
): Outcome {
  const warnings: string[] = [];
  const consent = consentOf(e.context);
  const name = eventName(e);
  const isConsentChange = e.type === 'track' && e.event === CONSENT_EVENT;
  // A workspace plan is about the operator's own tracking. The platform's carrier events are not
  // in it, and a strict plan must not drop the event that records a signup or imported consent.
  // `internal` is only set by acceptInternalItems, never by the public gateway.
  const platformEvent = opts.internal === true && isPlatformEvent(name);

  // A consent change is always recorded (also a "no"); nothing else is without the purpose allowed.
  if (!isConsentChange && !consentAllows(source, policy, consent)) return { kind: 'dropped', reason: 'no_consent' };

  let properties: Record<string, unknown> = 'properties' in e ? { ...(e.properties ?? {}) } : {};
  const plan = policy.plan;
  // A schema classifies the value's meaning: product.name can be non-personal even though an
  // unclassified name may identify a person. Only a published plan can make that exception.
  const nonPersonal = new Set(
    plan?.events
      .find((d) => d.name === name)
      ?.properties.filter((p) => !p.pii)
      .map((p) => p.name),
  );
  if (plan && !isConsentChange && !platformEvent && (e.type === 'track' || e.type === 'page' || e.type === 'screen')) {
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
      // Reserved personal keys are not "unknown" properties: they are removed, not a schema error.
      redactReservedProperties(properties, nonPersonal);
      const unknown = Object.keys(properties).filter((k) => !def.properties.some((p) => p.name === k));
      if (unknown.length && plan.unknownProperties !== 'allow') {
        const msg = `Properties not in the tracking plan for "${name}": ${unknown.join(', ')}`;
        if (plan.unknownProperties === 'block') return { kind: 'rejected', error: msg };
        warnings.push(msg);
      }
      // `required`/`type` problems concern properties the plan *does* declare. The plan schema has
      // no strictness setting for them, so they keep the default plan's advisory behaviour and do
      // not inherit the unrelated unknownEvents/unknownProperties decision (#623).
      if (problems.length) warnings.push(`"${name}": ${problems.join('; ')}`);
    }
  }
  // No plan (and unlisted events) get the same reserved-key removal: a track "Order Completed"
  // with properties.email must not put a plaintext address in the event store and the warehouse.
  if (!isConsentChange) redactReservedProperties(properties, nonPersonal);

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
