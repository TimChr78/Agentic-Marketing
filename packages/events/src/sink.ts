import { logger } from '@agentic-marketing/telemetry';
import type { EventBus } from './bus';
import type { EventStore } from './clickhouse';
import type { BusEvent } from './schema';

/** The durable consumer a worker-side sink reads with. */
export const CLICKHOUSE_SINK_CONSUMER = 'clickhouse-sink';

export interface SinkOptions {
  name?: string;
  /**
   * Drops events the filter judges ineligible (for example an erased person with no live identity).
   * It runs before every insert; the scheduled second erasure sweep removes rows that landed before
   * it, but a write that arrives later can still land until read-time exclusion (#1037) ships. A
   * filter must be idempotent: a crash re-delivers the batch.
   */
  filter?: (events: BusEvent[]) => Promise<BusEvent[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Why the store and the erasure filter cannot read this event, or `null` when every field they read
 * has a type they can use. A record like this cannot become readable on another delivery, so the
 * sink drops it rather than failing the batch (which would hold back every other tenant's events
 * until the stream's max age). The reason is a field name, never its value.
 */
export function unreadableEventReason(event: unknown): string | null {
  if (!isRecord(event)) return 'event';
  for (const field of ['workspaceId', 'sourceId', 'messageId', 'type', 'name', 'anonymousId', 'userId', 'timestamp', 'receivedAt'])
    if (typeof event[field] !== 'string') return field;
  for (const field of ['properties', 'traits', 'piiTraits', 'context']) if (!isRecord(event[field])) return field;
  if (!isRecord(event.consent) || Object.values(event.consent).some((value) => typeof value !== 'boolean')) return 'consent';
  for (const field of ['profileId', 'previousId', 'groupId'])
    if (event[field] !== undefined && typeof event[field] !== 'string') return field;
  // A timestamp ClickHouse cannot parse would make it reject the whole insert on every retry.
  if (Number.isNaN(Date.parse(event.timestamp as string))) return 'timestamp';
  if (Number.isNaN(Date.parse(event.receivedAt as string))) return 'receivedAt';
  return null;
}

/** The safe correlation fields of an event: its workspace and id, never its payload. */
const correlation = (event: unknown) => {
  const fields = isRecord(event) ? event : {};
  return {
    workspaceId: typeof fields.workspaceId === 'string' ? fields.workspaceId : undefined,
    eventId: typeof fields.messageId === 'string' ? fields.messageId : undefined,
  };
};

/**
 * ClickHouse sink (worker role): micro-batches of up to 10k events or 1 s, inserted, then acked.
 * A crash between insert and ack re-delivers the batch; ReplacingMergeTree collapses the copies.
 * The optional filter blocks events eligible for an erasure before they are inserted; it is a
 * mitigation, not proof that a later write cannot land (#1037).
 *
 * A record whose own fields cannot be read is dropped and logged before the filter runs, so a
 * missing map cannot make the filter throw for the whole batch. A dependency failure (the filter's
 * database, a key, ClickHouse) still rejects, so the batch is delivered again.
 */
export function runSink(bus: EventBus, store: EventStore, signal: AbortSignal, opts: SinkOptions = {}) {
  return bus.consume(
    { name: opts.name ?? CLICKHOUSE_SINK_CONSUMER, maxBatch: 10_000, ackWaitMs: 30_000 },
    async (events) => {
      const readable: BusEvent[] = [];
      for (const event of events) {
        const field = unreadableEventReason(event);
        if (field) {
          logger.error({ ...correlation(event), field }, 'event dropped from the sink batch: its payload could not be read');
          continue;
        }
        readable.push(event);
      }
      const kept = opts.filter ? await opts.filter(readable) : readable;
      const stored = kept.length ? await store.insert(kept) : 0;
      logger.debug({ events: events.length, stored, dropped: events.length - stored }, 'events stored');
    },
    signal,
  );
}
