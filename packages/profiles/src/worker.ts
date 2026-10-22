import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import type { Db } from '@agentic-marketing/db';
import { type BusEvent, type EventBus, SHARDS } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { applyEvents } from './resolve';

/**
 * Profile workers (worker role): one sequential consumer per shard, so each visitor's events are
 * applied in order. A batch is applied per workspace in one transaction.
 */
export function runProfileWorkers(deps: { bus: EventBus; db: Db; kp: KeyProvider; consumerPrefix?: string }, signal: AbortSignal) {
  const purposes = async (tx: Parameters<typeof publishedSingleton>[0]) =>
    (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  return Array.from({ length: SHARDS }, (_, shard) =>
    deps.bus.consume(
      { name: `${deps.consumerPrefix ?? 'profiles'}-${shard}`, shard, maxBatch: 200, maxWaitMs: 0, ackWaitMs: 30_000 },
      async (events) => {
        const byWorkspace = new Map<string, BusEvent[]>();
        for (const e of events) byWorkspace.set(e.workspaceId, [...(byWorkspace.get(e.workspaceId) ?? []), e]);
        for (const [ws, list] of byWorkspace) await deps.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, list, { kp: deps.kp, purposes }));
      },
      signal,
    ),
  );
}
