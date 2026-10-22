import { z } from 'zod';

// The Segment HTTP Tracking API event shapes (ADR-0008), so existing trackers (Segment
// analytics-next, RudderStack SDKs, server libraries) can send to the ingest gateway as is.

const Json = z.record(z.string(), z.unknown());
const Timestamp = z.union([z.iso.datetime({ offset: true }), z.iso.datetime()]);

const common = {
  messageId: z.string().min(1).max(100).optional(),
  anonymousId: z.string().min(1).max(200).optional(),
  userId: z.string().min(1).max(200).optional(),
  timestamp: Timestamp.optional(),
  sentAt: Timestamp.optional(),
  originalTimestamp: Timestamp.optional(),
  context: Json.optional(),
  integrations: Json.optional(),
};

export const InboundEvent = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('track'), event: z.string().min(1).max(200), properties: Json.optional(), ...common }),
    z.object({
      type: z.literal('page'),
      name: z.string().max(200).optional(),
      category: z.string().max(200).optional(),
      properties: Json.optional(),
      ...common,
    }),
    z.object({ type: z.literal('screen'), name: z.string().max(200).optional(), properties: Json.optional(), ...common }),
    z.object({ type: z.literal('identify'), traits: Json.optional(), ...common }),
    z.object({ type: z.literal('group'), groupId: z.string().min(1).max(200), traits: Json.optional(), ...common }),
    z.object({ type: z.literal('alias'), previousId: z.string().min(1).max(200), ...common }),
  ])
  .refine((e) => e.anonymousId || e.userId, { message: 'Every event needs an anonymousId or a userId' });
export type InboundEvent = z.infer<typeof InboundEvent>;
export type EventType = InboundEvent['type'];

/** An event after ingest: tenant-stamped, named, time-corrected and stripped to what consent allows. */
export interface BusEvent {
  workspaceId: string;
  sourceId: string;
  messageId: string;
  type: EventType;
  /** The event name: `event` for track, the page/screen name, otherwise the type. */
  name: string;
  anonymousId: string;
  userId: string;
  /** When it happened, corrected for client clock skew. */
  timestamp: string;
  receivedAt: string;
  properties: Record<string, unknown>;
  /** Traits that are not personal data; stored with the event. */
  traits: Record<string, unknown>;
  /** Personal-data traits (per the attribute schema). Only the profile worker reads them; they are never stored with the event. */
  piiTraits: Record<string, unknown>;
  context: Record<string, unknown>;
  /** Purpose → allowed, from the sender's consent signal (Segment `context.consent.categoryPreferences`). */
  consent: Record<string, boolean>;
  /** alias: the previous id; group: the group id. */
  previousId?: string;
  groupId?: string;
}

/** Segment's consent-change event; the profile worker records it in the consent ledger. */
export const CONSENT_EVENT = 'Segment Consent Preference Updated';

export function eventName(e: InboundEvent): string {
  switch (e.type) {
    case 'track':
      return e.event;
    case 'page':
      return e.name || 'page';
    case 'screen':
      return e.name || 'screen';
    default:
      return e.type;
  }
}

/**
 * Corrects the client clock the way Segment does: if the client says when it sent the batch, the
 * event happened (sentAt − timestamp) before we received it.
 */
export function correctedTimestamp(e: InboundEvent, receivedAt: Date): Date {
  const ts = e.timestamp ?? e.originalTimestamp;
  if (!ts) return receivedAt;
  const t = Date.parse(ts);
  const corrected = e.sentAt ? receivedAt.getTime() - (Date.parse(e.sentAt) - t) : t;
  // Nothing happened after we received it: a clock in the future would otherwise let an old
  // event (e.g. a consent) outrank later ones.
  return new Date(Math.min(corrected, receivedAt.getTime()));
}

export function consentOf(context: Record<string, unknown> | undefined): Record<string, boolean> | undefined {
  const prefs = (context?.consent as { categoryPreferences?: unknown } | undefined)?.categoryPreferences;
  if (!prefs || typeof prefs !== 'object') return undefined;
  return Object.fromEntries(Object.entries(prefs).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
}
