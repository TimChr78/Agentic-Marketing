import { newId } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { EgressPolicy } from '@agentic-marketing/integrations';
import { type KeyProvider, openJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { DATASETS, erasuresIn, readDataset } from './datasets';
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
 * One export run: every chosen dataset from its cursor up to now (less the lag), snapshots in
 * full, then the erasures since the last run. Cursors move only when the whole run succeeded, so
 * a failed run is repeated: Postgres upserts make that harmless, files may repeat rows.
 */
export async function runExport(deps: WarehouseDeps, ws: string, id: string) {
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
    const erasures = await erasuresIn(deps.db, ws, cursors.erasures ?? EPOCH, until);
    await dest.erase(erasures);
    counts.erasures = erasures.length;
    cursors.erasures = until;
    await finish(deps.db, ws, id, { cursors, lastStatus: 'ok', lastError: null, lastCounts: counts });
    logger.info({ workspace: ws, export: id, counts }, 'warehouse export done');
    return { status: 'ok' as const, counts };
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    await finish(deps.db, ws, id, { lastStatus: 'failed', lastError: message, lastCounts: counts });
    logger.warn({ workspace: ws, export: id, err }, 'warehouse export failed');
    return { status: 'failed' as const, counts, error: message };
  } finally {
    await dest?.close().catch(() => {});
  }
}

async function finish(db: Db, ws: string, id: string, set: Partial<typeof schema.warehouseExports.$inferInsert>) {
  await db.withWorkspace(ws, (tx) =>
    tx
      .update(schema.warehouseExports)
      .set({ ...set, runRequested: false, lastRunAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.warehouseExports.id, id)),
  );
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
    await new Promise((r) => setTimeout(r, deps.tickMs ?? 30_000));
  }
}
