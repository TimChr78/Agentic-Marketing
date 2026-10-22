import { logger } from '@agentic-marketing/telemetry';
import type { EventBus } from './bus';
import type { EventStore } from './clickhouse';

/**
 * ClickHouse sink (worker role): micro-batches of up to 10k events or 1 s, inserted, then acked.
 * A crash between insert and ack re-delivers the batch; ReplacingMergeTree collapses the copies.
 */
export function runSink(bus: EventBus, store: EventStore, signal: AbortSignal, opts: { name?: string } = {}) {
  return bus.consume(
    { name: opts.name ?? 'clickhouse-sink', maxBatch: 10_000, ackWaitMs: 30_000 },
    async (events) => {
      await store.insert(events);
      logger.debug({ events: events.length }, 'events stored');
    },
    signal,
  );
}
