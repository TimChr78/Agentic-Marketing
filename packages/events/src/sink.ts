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

/**
 * ClickHouse sink (worker role): micro-batches of up to 10k events or 1 s, inserted, then acked.
 * A crash between insert and ack re-delivers the batch; ReplacingMergeTree collapses the copies.
 * The optional filter blocks events eligible for an erasure before they are inserted; it is a
 * mitigation, not proof that a later write cannot land (#1037).
 */
export function runSink(bus: EventBus, store: EventStore, signal: AbortSignal, opts: SinkOptions = {}) {
  return bus.consume(
    { name: opts.name ?? CLICKHOUSE_SINK_CONSUMER, maxBatch: 10_000, ackWaitMs: 30_000 },
    async (events) => {
      const kept = opts.filter ? await opts.filter(events) : events;
      if (kept.length) await store.insert(kept);
      logger.debug({ events: kept.length, dropped: events.length - kept.length }, 'events stored');
    },
    signal,
  );
}
