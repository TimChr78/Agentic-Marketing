import { logger } from '@agentic-marketing/telemetry';
import type { EventBus } from './bus';
import type { EventStore } from './clickhouse';
import { eventCorrelation, normalizeEvent, unreadableEventReason } from './readable';
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

/**
 * ClickHouse sink (worker role): micro-batches of up to 10k events or 1 s, inserted, then acked.
 * A crash between insert and ack re-delivers the batch; ReplacingMergeTree collapses the copies.
 * The optional filter blocks events eligible for an erasure before they are inserted; it is a
 * mitigation, not proof that a later write cannot land (#1037).
 *
 * A queued record is checked against the fields the filter and the store read before either sees
 * it, so a record of the wrong shape cannot fail the batch. Values the writer already defaults (an
 * absent map, a `null` profile id) are recovered; only a record that can never become readable is
 * dropped, and it is logged with its workspace and event id only. A dependency failure (the
 * filter's database, a key, ClickHouse) still rejects, so the batch is delivered again.
 */
export function runSink(bus: EventBus, store: EventStore, signal: AbortSignal, opts: SinkOptions = {}) {
  return bus.consume(
    { name: opts.name ?? CLICKHOUSE_SINK_CONSUMER, maxBatch: 10_000, ackWaitMs: 30_000 },
    async (events) => {
      const readable: BusEvent[] = [];
      for (const event of events) {
        normalizeEvent(event);
        const field = unreadableEventReason(event);
        if (field) {
          logger.error({ ...eventCorrelation(event), field }, 'event dropped from the sink batch: its payload could not be read');
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
