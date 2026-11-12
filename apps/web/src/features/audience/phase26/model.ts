import type { Out } from '../../../app/api';
import { eventTypeLabel, PURPOSE_LABEL } from '../../../lib/labels';
import { formatDateTime } from '../../../ui/time';

// Pure model helpers for the People surface (#510). The contract's units are people rows, one
// consent choice per purpose, and a timeline merged from three independently paged sources.

export type ProfileRow = Out<'profiles.list'>['profiles'][number];
export type PersonProfile = Out<'profiles.get'>;
export type PersonEvent = Out<'profiles.events'>['events'][number];
export type PersonMessage = Out<'messages.list'>['messages'][number];
export type ConsentRecord = Out<'consent.history'>['records'][number];
export type Purpose = Out<'purposes.list'>['purposes'][number];

/** The server's marker for a personal value the caller may not see. */
export const HIDDEN = '[hidden]';

function joinName(...values: unknown[]): string | null {
  const parts = values.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v && v !== HIDDEN);
  return parts.length ? parts.join(' ') : null;
}

/** A name from non-personal traits only; null when the server did not send one. */
export function displayNameFromTraits(traits: Record<string, unknown>): string | null {
  const first = joinName(traits.firstName);
  const last = joinName(traits.lastName);
  const full = [first, last].filter(Boolean).join(' ');
  return full || joinName(traits.name);
}

/**
 * A name from the server-redacted personal record, falling back to non-personal traits only when
 * no personal name field exists at all. A `[hidden]` personal name never falls back.
 */
export function displayNameFromProfile(profile: PersonProfile): string | null {
  const personal = profile.personal ?? {};
  const hasPersonalName = ['name', 'firstName', 'lastName'].some((key) => key in personal);
  if (hasPersonalName) {
    const first = joinName(personal.firstName);
    const last = joinName(personal.lastName);
    const full = [first, last].filter(Boolean).join(' ');
    return full || joinName(personal.name);
  }
  return displayNameFromTraits(profile.traits);
}

export type Identity = { email: string; name: string | null; hidden: boolean };

/** One primary e-mail and its visible name. PII absence is its own honest state, not anonymity. */
export function listIdentity(row: ProfileRow, canSeePii: boolean): Identity {
  if (!canSeePii) return { email: 'Email hidden', name: 'Name hidden', hidden: true };
  return { email: row.email ?? 'No email available', name: displayNameFromTraits(row.traits), hidden: false };
}

export function personIdentity(profile: PersonProfile, canSeePii: boolean): Identity {
  const email = profile.personal?.email;
  if (!canSeePii || email === HIDDEN) return { email: 'Email hidden', name: 'Name hidden', hidden: true };
  return {
    email: typeof email === 'string' && email ? email : 'No email available',
    name: displayNameFromProfile(profile),
    hidden: false,
  };
}

const STATUS_LABEL: Record<string, string> = {
  granted: 'Allowed',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  objected: 'Objected',
};

export function consentLabel(status: string | null | undefined): string {
  if (!status) return 'No recorded choice';
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

export const consentTone = (status: string | null | undefined) =>
  status === 'granted' ? 'good' : status === 'objected' ? 'bad' : status === 'withdrawn' || status === 'denied' ? 'warn' : 'neutral';

/**
 * Mirrors the frozen server rule (`purposeAllowed` in packages/profiles/src/consent.ts) so a
 * missing record is never presented as a refusal: consent needs a current grant, legitimate
 * interest holds unless the person refused, and contract/legal obligation always holds.
 * Null means the basis is unavailable, so the UI makes no eligibility claim.
 */
export function purposeAllowed(basis: string | null | undefined, status: string | null | undefined): boolean | null {
  if (!basis) return null;
  if (basis === 'consent') return status === 'granted';
  if (basis === 'legitimate_interest') return status !== 'objected' && status !== 'withdrawn' && status !== 'denied';
  return true;
}

export function basisLabel(basis: string | null | undefined): string | null {
  if (!basis) return null;
  const labels: Record<string, string> = {
    consent: 'Consent',
    legitimate_interest: 'Legitimate interest',
    contract: 'Contract',
    legal_obligation: 'Legal obligation',
  };
  return labels[basis] ?? basis.replace(/_/g, ' ');
}

export function purposeName(purposeKey: string, purposes: readonly Purpose[] | undefined): string | null {
  return purposes?.find((p) => p.key === purposeKey)?.name ?? null;
}

export type EffectiveChannel = {
  channel: string;
  status: string | null;
  allowed: boolean;
};

export type EffectiveConsent = PersonProfile['consentEffective'][number];

export type PurposeRow = {
  key: string;
  name: string | null;
  basis: string | null;
  channel: string | null;
  status: string | null;
  source: string | null;
  updatedAt: string | null;
  eligible: boolean | null;
  /** The effective status per channel as the server computed it; empty for a list row. */
  channels: EffectiveChannel[];
};

type ConsentEntry = {
  purpose: string;
  status: string | null;
  basis?: string;
  channel?: string;
  source?: string;
  updatedAt?: string;
};

/**
 * One row per purpose in force. The list read already returns every purpose with a null status
 * when the person recorded nothing; the detail read may only return recorded purposes, so the
 * purpose metadata fills the gap. The person detail passes the server's `consentEffective` so the
 * page shows exactly what delivery decides — the per-channel rule included — instead of
 * re-deriving precedence from unordered raw rows (#593).
 */
export function purposeRows(
  consent: readonly ConsentEntry[],
  purposes: readonly Purpose[] | undefined,
  options: { includeUnrecorded?: boolean; effective?: readonly EffectiveConsent[] } = {},
): PurposeRow[] {
  const byKey = new Map((options.effective ?? []).map((c) => [c.purpose, c]));
  const byConsent = new Map(consent.map((c) => [c.purpose, c]));
  const keys = purposes?.length
    ? purposes.map((p) => p.key)
    : (options.effective ?? []).length
      ? (options.effective ?? []).map((c) => c.purpose)
      : consent.map((c) => c.purpose);
  for (const c of options.effective ?? []) if (!keys.includes(c.purpose)) keys.push(c.purpose);
  for (const c of consent) if (!keys.includes(c.purpose)) keys.push(c.purpose);
  return keys.map((key) => {
    const meta = purposes?.find((p) => p.key === key);
    const effective = byKey.get(key);
    if (effective)
      return {
        key,
        name: meta?.name ?? null,
        basis: effective.basis,
        channel: null,
        status: effective.status,
        source: null,
        updatedAt: null,
        eligible: effective.allowed,
        channels: effective.channels,
      };
    const entry = byConsent.get(key);
    const basis = entry?.basis ?? meta?.basis ?? null;
    const status = entry?.status ?? null;
    return {
      key,
      name: meta?.name ?? null,
      basis,
      channel: entry?.channel || null,
      status,
      source: entry?.source ?? null,
      updatedAt: entry?.updatedAt ?? null,
      eligible: purposeAllowed(basis, status),
      channels: [],
    };
  });
}

/** The header is explicit that only loaded rows are counted; there is no population total. */
export function shownLabel(shown: number, page: number): string {
  return `${shown.toLocaleString('en-US')} shown · Page ${page}`;
}

export function availabilityLabel(next: boolean): string {
  return next ? 'More people available' : 'End of list';
}

export type TimelineKind = 'event' | 'message' | 'message-event' | 'consent';

export type TimelineItem = {
  key: string;
  at: string;
  kind: TimelineKind;
  source: string;
  title: string;
  detail: string | null;
};

const KIND_ORDER: Record<TimelineKind, number> = { event: 0, 'message-event': 1, message: 2, consent: 3 };

function validTime(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

/**
 * Interleaves the loaded events, message creations, returned message events and consent changes.
 * Stable keys are prefixed by source. Message events are not deduplicated against profile events:
 * the two lanes have no common id contract, so both are shown with their source named.
 */
export function buildTimeline({
  events,
  messages,
  consent,
  purposes,
}: {
  events: readonly PersonEvent[];
  messages: readonly PersonMessage[];
  consent: readonly ConsentRecord[];
  purposes: readonly Purpose[] | undefined;
}): TimelineItem[] {
  const items: TimelineItem[] = [];
  const purposeText = (key: string) => purposeName(key, purposes) ?? PURPOSE_LABEL[key] ?? null;

  for (const event of events) {
    const ms = validTime(event.timestamp);
    if (ms === null) continue;
    items.push({
      key: `event:${event.eventId}`,
      at: event.timestamp,
      kind: 'event',
      source: 'Event',
      title: event.name || eventTypeLabel(event.type),
      detail: eventTypeLabel(event.type),
    });
  }

  for (const message of messages) {
    const created = validTime(message.createdAt);
    if (created !== null) {
      const purpose = purposeText(message.purpose);
      items.push({
        key: `message:${message.id}`,
        at: message.createdAt,
        kind: 'message',
        source: 'Message',
        title: purpose ? `${purpose} message` : 'Message',
        detail: `Message created · ${message.channel} · ${message.status.replace(/_/g, ' ')}`,
      });
    }
    message.events.forEach((event, index) => {
      if (validTime(event.at) === null) return;
      const purpose = purposeText(message.purpose);
      items.push({
        key: `message-event:${message.id}:${index}:${event.type}:${event.at}`,
        at: event.at,
        kind: 'message-event',
        source: 'Message event',
        title: `${purpose ?? 'Message'} ${lowerFirst(eventTypeLabel(event.type))}`,
        detail: [purpose ? `${purpose} purpose` : null, message.channel, event.reason || null].filter(Boolean).join(' · ') || null,
      });
    });
  }

  consent.forEach((record, index) => {
    if (validTime(record.recordedAt) === null) return;
    const purpose = purposeText(record.purpose);
    items.push({
      key: `consent:${record.recordedAt}:${record.purpose}:${record.channel}:${record.status}:${index}`,
      at: record.recordedAt,
      kind: 'consent',
      source: 'Consent change',
      title: `${purpose ?? 'Purpose'} · ${consentLabel(record.status)}`,
      detail: ['Consent', record.channel || null, record.source ? record.source.replace(/_/g, ' ') : null].filter(Boolean).join(' · '),
    });
  });

  return items.sort((a, b) => {
    const delta = (validTime(b.at) ?? 0) - (validTime(a.at) ?? 0);
    if (delta) return delta;
    const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return kind || a.key.localeCompare(b.key);
  });
}

export function timelineCounts(events: number, messages: number, consent: number): string {
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  return [
    `${plural(events, 'event', 'events')} loaded`,
    `${plural(messages, 'message', 'messages')} loaded`,
    `${plural(consent, 'consent record', 'consent records')} loaded`,
  ].join(' · ');
}

/**
 * The newest loaded timestamp, named for what it is. There is no bounded period on this surface,
 * so the timeline never claims pipeline freshness or completeness.
 */
export function latestLoadedLabel(items: readonly TimelineItem[]): string {
  let latest: number | null = null;
  for (const item of items) {
    const ms = validTime(item.at);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest === null ? 'Unavailable' : formatDateTime(new Date(latest).toISOString());
}
