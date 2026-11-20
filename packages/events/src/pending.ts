import { z } from 'zod';
import type { MessageEvent } from './clickhouse';
import { personReadSource } from './protected';

// Message events reach ClickHouse after the transaction that recorded them commits, through the
// outbox (0.15.0). A decision that reads ClickHouse metrics before publication would miss them, so
// it can hand the queued events to the same query: the metric reads published rows UNION ALL a
// bounded snapshot of what the outbox still owes, de-duplicated on the table's replacing key.
// Reconstructing the events from SQL status instead cannot match the metric semantics: a soft
// bounce is a `bounced` event whose message stays `sent`, a later complaint overwrites an earlier
// bounce status, and a broadcast's denominator is distinct people, not messages (#1008 review).

const MESSAGE_EVENT_TYPES = [
  'queued',
  'sent',
  'suppressed',
  'failed',
  'delivered',
  'bounced',
  'deferred',
  'complained',
  'opened',
  'clicked',
  'unsubscribed',
] as const;

/** Complete shape of one ClickHouse message event; a partial object would fail inside ClickHouse. */
export const messageEventSchema = z.object({
  workspaceId: z.string().min(1),
  messageId: z.string().min(1),
  eventId: z.string().min(1),
  type: z.enum(MESSAGE_EVENT_TYPES),
  at: z.string().min(1),
  profileId: z.string(),
  channel: z.string().min(1),
  purpose: z.string(),
  provider: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int().nonnegative(),
  journeyId: z.string(),
  variant: z.string().optional(),
  reason: z.string(),
  url: z.string(),
});

/** The payload one `message_event` outbox row carries: exactly the events it will publish. */
export const messageEventPayloadSchema = z.object({
  events: z.array(messageEventSchema).min(1),
  /**
   * When the batch was queued, so the carrier events it publishes keep the delivery time they had
   * then even if the row is delivered or requeued days later (#1027). Rows written before this
   * field existed have none; the dispatcher falls back to the row's `created_at`.
   */
  receivedAt: z.string().min(1).optional(),
});

/**
 * The events an outbox payload carries. Throws when the payload is not a well-formed batch: such a
 * row cannot have been a real event, so a reader that finds one cannot count it either.
 */
export function parseMessageEventPayload(payload: unknown): MessageEvent[] {
  return messageEventPayloadSchema.parse(payload).events;
}

/**
 * Columns a pending-event snapshot supplies, in `message_events`' own names. Only what the metric
 * layer reads: dimensions (channel, template, journey, purpose, variant), filters, profiles and the
 * event identity. A new measure that reads another column must add it here.
 */
const SNAPSHOT_COLUMNS = [
  'workspace_id',
  'message_id',
  'event_id',
  'type',
  'at',
  'profile_id',
  'channel',
  'purpose',
  'template_id',
  'journey_id',
  'variant',
] as const;

const columnList = SNAPSHOT_COLUMNS.join(', ');
const arrayString = (name: string) => `{${name}:Array(String)}`;

/**
 * A `FROM` source that reads published message events plus the events still queued for
 * publication, so a metric query sees what it will see once the outbox catches up.
 *
 * The published half reads the workspace's protected source (#1037 part 2) — the protected view
 * when the workspace has a durable erasure ledger, the base table otherwise — so it dedupes the
 * replacing table and excludes erased subjects, and its row policy is unchanged.
 *
 * The snapshot half is built from parallel `Array(String)` parameters over `numbers()` — no
 * per-row SQL text — and a `LEFT ANTI JOIN` drops any snapshot event that is already published: a
 * dispatcher that publishes between the snapshot and the read must leave the event counted once,
 * not twice. The anti-join reads the base table, because it needs identity columns only; that keeps
 * the protected source to one use in the union, so its ledger set is built once.
 *
 * The caller applies its own WHERE to the result exactly as it would to the table, so filters,
 * channels and the time window describe both halves alike.
 *
 * `params` must already carry `ws` (the workspace UUID); this function adds its own `pending_*`
 * entries. Bounded by the caller: every row costs a parameter slot.
 */
export function messageEventsWithPending(rows: readonly MessageEvent[], params: Record<string, unknown>, protectedRead = true): string {
  const published = `${personReadSource('message_events', protectedRead)} FINAL`;
  if (!rows.length) return published;
  const at = rows.map((e) => e.at.replace('Z', ''));
  params.pending_n = rows.length;
  params.pending_at = at;
  params.pending_message_id = rows.map((e) => e.messageId);
  params.pending_event_id = rows.map((e) => e.eventId);
  params.pending_type = rows.map((e) => e.type);
  params.pending_profile_id = rows.map((e) => e.profileId);
  params.pending_channel = rows.map((e) => e.channel);
  params.pending_purpose = rows.map((e) => e.purpose);
  params.pending_template_id = rows.map((e) => e.templateId);
  params.pending_journey_id = rows.map((e) => e.journeyId);
  params.pending_variant = rows.map((e) => e.variant ?? '');
  params.pending_message_ids = [...new Set(rows.map((e) => e.messageId))];

  const element = (name: string) => `arrayElement(${arrayString(name)}, number + 1)`;
  return `(SELECT ${columnList} FROM ${published}
    UNION ALL
    SELECT ${columnList} FROM (
      SELECT
        {ws:UUID} AS workspace_id,
        ${element('pending_message_id')} AS message_id,
        ${element('pending_event_id')} AS event_id,
        ${element('pending_type')} AS type,
        parseDateTime64BestEffort(${element('pending_at')}, 3, 'UTC') AS at,
        ${element('pending_profile_id')} AS profile_id,
        ${element('pending_channel')} AS channel,
        ${element('pending_purpose')} AS purpose,
        ${element('pending_template_id')} AS template_id,
        ${element('pending_journey_id')} AS journey_id,
        ${element('pending_variant')} AS variant
      FROM numbers({pending_n:UInt64})
    ) AS queued
    -- The dedupe key set, not a read of the person's data: only the three identity columns leave
    -- this subquery, and a queued event shares its profile with its published twin, so exclusion
    -- cannot change whether these two rows are the same event. Reading the base table here keeps
    -- the protected source (and its ledger set) to one use in the union.
    LEFT ANTI JOIN (
      SELECT toString(message_id) AS message_id, toString(type) AS type, toString(event_id) AS event_id
      FROM message_events FINAL
      WHERE workspace_id = {ws:UUID} AND message_id IN {pending_message_ids:Array(String)}
    ) AS published
    ON queued.message_id = published.message_id AND queued.type = published.type AND queued.event_id = published.event_id)`;
}
