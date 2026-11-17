import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import type { Db } from '@agentic-marketing/db';
import { type BusEvent, type EventBus, SHARDS } from '@agentic-marketing/events';
import { type KeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { personCrypto } from './crypto';
import { applyEvents, profileIdsForBatch, type ResolvedEvent } from './resolve';

/** Called after a batch of a workspace's events is applied (and committed), e.g. by segments and journeys. */
export type AfterResolve = (workspaceId: string, resolved: ResolvedEvent[]) => Promise<void>;

/**
 * Profile workers (worker role): one sequential consumer per shard, so each visitor's events are
 * applied in order. A batch is applied per workspace in one transaction.
 *
 * The keys the batch can need are unwrapped before that transaction (`prepareKeys`), because the
 * transaction takes the identity lock before its first event and must not make a network call while
 * it holds it. A key that changed in between raises `KeysChangedError`, which rolls the transaction
 * back and prepares again.
 */
export function runProfileWorkers(
  deps: { bus: EventBus; db: Db; kp: KeyProvider; consumerPrefix?: string; after?: AfterResolve[]; erasureGraceHours?: number },
  signal: AbortSignal,
) {
  const purposes = async (tx: Parameters<typeof publishedSingleton>[0]) =>
    (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  return Array.from({ length: SHARDS }, (_, shard) =>
    deps.bus.consume(
      { name: `${deps.consumerPrefix ?? 'profiles'}-${shard}`, shard, maxBatch: 200, maxWaitMs: 0, ackWaitMs: 30_000 },
      async (events) => {
        const byWorkspace = new Map<string, BusEvent[]>();
        for (const e of events) byWorkspace.set(e.workspaceId, [...(byWorkspace.get(e.workspaceId) ?? []), e]);
        for (const [ws, list] of byWorkspace) {
          // Two short reads outside the protected transaction: which profiles the batch names, so
          // their per-person keys are prepared too. The batch resolves them again under the lock.
          const resolved = await withPreparedKeys(
            async () => {
              const profileIds = await deps.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, list, personCrypto(tx, ws, deps.kp)));
              return prepareKeys(deps.db, ws, deps.kp, { profileIds });
            },
            (prepared) =>
              deps.db.withWorkspace(ws, (tx) =>
                applyEvents(tx, ws, list, { prepared, purposes, erasureGraceHours: deps.erasureGraceHours }),
              ),
          );
          // Hooks run after the commit, so they see the updated profiles. A failing hook makes
          // the batch re-deliver; applying it again is a no-op, so hooks must be idempotent too.
          for (const hook of deps.after ?? []) await hook(ws, resolved);
        }
      },
      signal,
    ),
  );
}
