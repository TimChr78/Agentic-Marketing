import { setTimeout as delay } from 'node:timers/promises';
import { newId } from '@agentic-marketing/core';
import { type Db, schema, type WarehouseDataset } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { EgressPolicy } from '@agentic-marketing/integrations';
import { type KeyProvider, openJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, count, eq, sql } from 'drizzle-orm';
import { DATASETS, erasuresForExport, pruneErasureKeys, readDataset } from './datasets';
import { type Destination, postgresConfig, postgresDestination, postgresSecrets, s3Config, s3Destination, s3Secrets } from './destinations';

export interface WarehouseDeps {
  db: Db;
  events: EventStore;
  kp: KeyProvider;
  egress: EgressPolicy;
  /** How far behind now an export reads, so late commits and sunk events land in the next window. */
  lagMs?: number;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * A destination reported an erasure it could not apply to every dataset it holds. Retrying cannot
 * recover keys that no longer exist, so the cursor still advances and the outstanding manual
 * cleanup is kept in `warehouse_erasure_backlog`.
 */
export const CLEANUP_PENDING_PREFIX = 'erasure cleanup pending';
export const INCOMPLETE_ERASURE_PREFIX = 'erasure not fully applied';

export function cleanupPendingWarning(pending: number): string {
  return `${CLEANUP_PENDING_PREFIX} for ${pending} erasure(s): finish the downstream cleanup, then review warehouse.erasureBacklog and acknowledge the erasures with warehouse.acknowledgeErasures`;
}

function incompleteWarning(incomplete: { id: string; uncovered: string[] }[]): string {
  return `${INCOMPLETE_ERASURE_PREFIX} downstream for ${incomplete.length} person(s): ${incomplete
    .flatMap((e) => e.uncovered)
    .join(
      ', ',
    )} data could not be located (the erasure predates key tracking, or its keys were already pruned); remove it downstream manually, then acknowledge it with warehouse.acknowledgeErasures`;
}

/** The run's visible failure: the incomplete erasures just reported, else anything still in the backlog. */
export function pendingErasureWarning(incomplete: { id: string; uncovered: string[] }[], backlogCount: number): string | null {
  if (incomplete.length) return incompleteWarning(incomplete);
  return backlogCount ? cleanupPendingWarning(backlogCount) : null;
}

export type ExportRunResult =
  | { status: 'ok'; counts: Record<string, number> }
  | { status: 'failed'; counts: Record<string, number>; error: string }
  | { status: 'skipped'; counts: Record<string, number> };

/**
 * One export run: every chosen dataset from its cursor up to now (less the lag), snapshots in
 * full, then the erasures since the last run. Dataset cursors move only when the whole run
 * succeeded, so a failed run is repeated: Postgres upserts make that harmless, files may repeat
 * rows. The erasure cursor also moves when a destination reported an incomplete erasure: it has
 * been told, and a retry cannot recover keys that are gone. What is left is a manual cleanup,
 * recorded per export in `warehouse_erasure_backlog` and kept visible until a person acknowledges it.
 *
 * Runs of the same export are serialized with a session advisory lock on a dedicated admin
 * connection: no HTTP happens inside a transaction, and a second scheduler tick/request skips
 * instead of racing the cursor, destination DDL or backlog.
 */
export async function runExport(deps: WarehouseDeps, ws: string, id: string): Promise<ExportRunResult> {
  const lockClient = await deps.db.admin.connect();
  const lockKey = `warehouse-export:${ws}:${id}`;
  let locked = false;
  let destroy = false;
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked', [
      lockKey,
    ]);
    if (!rows[0]?.locked) {
      logger.info({ workspace: ws, export: id }, 'warehouse export already running; skipping this tick');
      return { status: 'skipped', counts: {} };
    }
    locked = true;
    return await exportOnce(deps, ws, id);
  } finally {
    if (locked)
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [lockKey]).catch((err: unknown) => {
        destroy = true;
        logger.warn({ workspace: ws, export: id, err }, 'warehouse export lock release failed');
      });
    lockClient.release(destroy);
  }
}

async function exportOnce(deps: WarehouseDeps, ws: string, id: string): Promise<ExportRunResult> {
  const row = await deps.db.withWorkspace(ws, async (tx) => {
    const [r] = await tx.select().from(schema.warehouseExports).where(eq(schema.warehouseExports.id, id));
    if (!r) throw new Error(`warehouse export ${id} is gone`);
    const secrets = r.secrets && r.secretsKeyId ? await openJson<Record<string, unknown>>(tx, ws, deps.kp, r.secrets, r.secretsKeyId) : {};
    return { ...r, secrets };
  });
  const until = new Date(Date.now() - (deps.lagMs ?? 120_000)).toISOString();
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${newId('run').slice(-6)}`;
  const counts: Record<string, number> = {};
  const cursors = { ...row.cursors };
  let dest: Destination | undefined;
  try {
    dest =
      row.kind === 'postgres'
        ? await postgresDestination(ws, postgresConfig.parse(row.config), postgresSecrets.parse(row.secrets), deps.egress)
        : s3Destination(ws, s3Config.parse(row.config), s3Secrets.parse(row.secrets), deps.egress, runId);
    for (const dataset of row.datasets) {
      counts[dataset] = 0;
      if (DATASETS[dataset].mode === 'snapshot') {
        await dest.beginSnapshot(dataset);
        for await (const rows of readDataset(deps, ws, dataset, EPOCH, until)) {
          await dest.writeSnapshot(dataset, rows);
          counts[dataset] += rows.length;
        }
        await dest.endSnapshot(dataset);
        continue;
      }
      const since = cursors[dataset] ?? EPOCH;
      if (since >= until) continue;
      for await (const rows of readDataset(deps, ws, dataset, since, until)) {
        await dest.write(dataset, rows);
        counts[dataset] += rows.length;
      }
      cursors[dataset] = until;
    }
    const erasures = await erasuresForExport(deps.db, ws, cursors.erasures ?? EPOCH, until, row.datasets, row.createdAt.toISOString());
    const report = await dest.erase(erasures);
    counts.erasures = report.applied;
    if (report.incomplete.length) counts.erasuresIncomplete = report.incomplete.length;
    // The destination has been told about every erasure in the window, including those it could
    // not fully apply. Advance regardless: a retry cannot recover keys that were never captured or
    // were pruned, and pinning the cursor would retain every later raw key forever.
    cursors.erasures = until;
    const { warning, backlogCount } = await finishRun(deps.db, ws, id, {
      cursors,
      counts,
      incomplete: report.incomplete.map((e) => ({ id: e.id, uncovered: e.uncovered })),
      processed: erasures.map((e) => e.id),
    });
    // Keys are only dropped once every enabled destination has processed the erasure it needed
    // them for. Since the cursor advances on an incomplete erasure too, later keys stay prunable.
    await pruneErasureKeys(deps.db, ws).catch((err) => logger.warn({ workspace: ws, err }, 'warehouse erasure key cleanup failed'));
    if (warning) {
      logger.warn({ workspace: ws, export: id, counts, backlog: backlogCount }, 'warehouse erasure cleanup is pending');
      return { status: 'failed', counts, error: warning };
    }
    logger.info({ workspace: ws, export: id, counts }, 'warehouse export done');
    return { status: 'ok', counts };
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    await finish(deps.db, ws, id, { lastStatus: 'failed', lastError: message, lastCounts: counts });
    logger.warn({ workspace: ws, export: id, err }, 'warehouse export failed');
    return { status: 'failed', counts, error: message };
  } finally {
    await dest?.close().catch(() => {});
  }
}

/**
 * Writes the run state, the backlog and the derived failure together, under the export row's lock so
 * a concurrent acknowledgement cannot be undone by a late finish (and vice versa). Also refreshes
 * the failure from the backlog, so an otherwise-successful empty run cannot hide pending cleanups.
 */
async function finishRun(
  db: Db,
  ws: string,
  id: string,
  input: {
    cursors: Record<string, string>;
    counts: Record<string, number>;
    incomplete: { id: string; uncovered: string[] }[];
    processed: string[];
  },
): Promise<{ warning: string | null; backlogCount: number }> {
  return db.withWorkspace(ws, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM warehouse_exports WHERE workspace_id = ${ws} AND id = ${id} FOR UPDATE`);
    // Bound VALUES parameters too: a large first export can report many legacy erasures.
    for (let offset = 0; offset < input.incomplete.length; offset += 5000) {
      await tx
        .insert(schema.warehouseErasureBacklog)
        .values(
          input.incomplete.slice(offset, offset + 5000).map((e) => ({
            workspaceId: ws,
            exportId: id,
            erasureId: e.id,
            datasets: e.uncovered as WarehouseDataset[],
          })),
        )
        .onConflictDoUpdate({
          target: [
            schema.warehouseErasureBacklog.workspaceId,
            schema.warehouseErasureBacklog.exportId,
            schema.warehouseErasureBacklog.erasureId,
          ],
          set: { datasets: sql`excluded.datasets`, updatedAt: new Date() },
        });
    }
    const incompleteIds = new Set(input.incomplete.map((e) => e.id));
    const completed = input.processed.filter((erasureId) => !incompleteIds.has(erasureId));
    if (completed.length)
      await tx
        .delete(schema.warehouseErasureBacklog)
        .where(
          and(
            eq(schema.warehouseErasureBacklog.workspaceId, ws),
            eq(schema.warehouseErasureBacklog.exportId, id),
            sql`${schema.warehouseErasureBacklog.erasureId} = ANY(${sql.param(completed)}::text[])`,
          ),
        );
    const [{ pending }] = await tx
      .select({ pending: count() })
      .from(schema.warehouseErasureBacklog)
      .where(and(eq(schema.warehouseErasureBacklog.workspaceId, ws), eq(schema.warehouseErasureBacklog.exportId, id)));
    const backlogCount = Number(pending);
    if (backlogCount) input.counts.erasuresBacklog = backlogCount;
    const warning = pendingErasureWarning(input.incomplete, backlogCount);
    await tx
      .update(schema.warehouseExports)
      .set({
        cursors: input.cursors,
        lastStatus: warning ? 'failed' : 'ok',
        lastError: warning,
        lastCounts: input.counts,
        runRequested: false,
        lastRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.warehouseExports.id, id));
    return { warning, backlogCount };
  });
}

async function finish(db: Db, ws: string, id: string, set: Partial<typeof schema.warehouseExports.$inferInsert>) {
  await db.withWorkspace(ws, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM warehouse_exports WHERE workspace_id = ${ws} AND id = ${id} FOR UPDATE`);
    await tx
      .update(schema.warehouseExports)
      .set({ ...set, runRequested: false, lastRunAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.warehouseExports.id, id));
  });
}

/** Scheduler role: runs exports when they are due or were asked to run. */
export async function runWarehouseExports(deps: WarehouseDeps & { tickMs?: number }, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
        `SELECT workspace_id, id FROM warehouse_exports
         WHERE enabled AND (run_requested OR last_run_at IS NULL OR last_run_at < now() - every_minutes * interval '1 minute')
         ORDER BY run_requested DESC, last_run_at NULLS FIRST LIMIT 10`,
      );
      for (const r of rows) {
        if (signal.aborted) break;
        await runExport(deps, r.workspace_id, r.id);
      }
    } catch (err) {
      logger.error({ err }, 'warehouse export round failed');
    }
    await delay(deps.tickMs ?? 30_000, undefined, { signal }).catch((err: unknown) => {
      if (!signal.aborted) throw err;
    });
  }
}
