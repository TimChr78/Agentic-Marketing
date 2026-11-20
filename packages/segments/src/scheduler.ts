import { sleep } from '@agentic-marketing/core';
import type { Db, Tx } from '@agentic-marketing/db';
import { schema } from '@agentic-marketing/db';
import type { BusEvent, EventBus, EventStore } from '@agentic-marketing/events';
import { logger } from '@agentic-marketing/telemetry';
import { sql } from 'drizzle-orm';
import { type PublishedSegment, publishedSegments, publishInSlices, refreshSegment } from './membership';

/**
 * Recomputes segments whose published version changed right away, and every segment periodically,
 * so time windows ("in the last 7 days") also make people leave.
 *
 * One segment is the unit of failure: a definition the store cannot evaluate (an oversized
 * `within`, a purpose that is no longer published, a ClickHouse refusal) is logged and rolled back
 * to its own savepoint, and the round continues with the next segment and the next workspace. A
 * transaction that a failed statement aborted would otherwise take every later segment with it,
 * and a throw would skip every later workspace in `SELECT DISTINCT workspace_id` (#1073).
 */
export async function runSegmentScheduler(
  deps: {
    db: Db;
    events: EventStore;
    bus: EventBus;
    everyMs?: number;
    tickMs?: number;
    /** Called with the people a run moved in or out (e.g. to refresh their snapshots right away). */
    afterRefresh?: (workspaceId: string, profileIds: string[]) => Promise<void>;
  },
  signal: AbortSignal,
) {
  const every = deps.everyMs ?? 15 * 60_000;
  while (!signal.aborted) {
    let workspaces: { workspace_id: string }[] = [];
    try {
      ({ rows: workspaces } = await deps.db.admin.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace_id FROM artifacts WHERE type = 'segment' AND published_version IS NOT NULL AND NOT archived`,
      ));
    } catch (err) {
      logger.error({ err }, 'segment scheduler could not list workspaces');
    }
    for (const { workspace_id: ws } of workspaces) {
      // A workspace is the batch item: a stop lands between workspaces, not after the last one.
      if (signal.aborted) break;
      try {
        const changed = await deps.db.withWorkspace(ws, async (tx) => {
          const all = await publishedSegments(tx);
          const runs = new Map((await tx.select().from(schema.segmentRuns)).map((r) => [r.segmentId, r]));
          const out: BusEvent[] = [];
          const touched = new Set<string>();
          // `all` is ordered by segment id, and each refresh takes that segment's membership lock
          // (#1104): this transaction therefore always locks them in one order, whatever the round
          // skips.
          for (const seg of all) {
            if (seg.definition.mode !== 'dynamic') continue;
            const last = runs.get(seg.id);
            if (last && last.version === seg.version && Date.now() - last.at.getTime() < every) continue;
            const r = await refreshOne(tx, ws, seg, deps.events, all);
            if (!r) continue;
            logger.info({ workspace: ws, segment: seg.id, members: r.members, entered: r.entered, exited: r.exited }, 'segment recomputed');
            for (const e of r.changes) out.push(e);
            for (const p of r.changedProfiles) touched.add(p);
          }
          await publishInSlices(deps.bus, out);
          return [...touched];
        });
        if (changed.length && deps.afterRefresh) await deps.afterRefresh(ws, changed);
      } catch (err) {
        // The workspace could not even be read (a pooled connection, its artifacts): the other
        // workspaces still get their round.
        logger.error({ err, workspace: ws }, 'segment refresh failed for a workspace; continuing');
      }
    }
    await sleep(deps.tickMs ?? 30_000, signal);
  }
}

/**
 * One segment inside its own savepoint, so a statement that aborted the transaction can be rolled
 * back while the rest of the round's writes survive. Returns null when this segment failed.
 */
async function refreshOne(tx: Tx, workspaceId: string, seg: PublishedSegment, events: EventStore, all: PublishedSegment[]) {
  const savepoint = `segment_refresh_${seg.id.replace(/[^a-z0-9_]/gi, '_')}`;
  await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
  try {
    const result = await refreshSegment(tx, workspaceId, seg, events, all);
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
    return result;
  } catch (err) {
    // Name the segment and keep the message; never the definition, which can hold personal data.
    logger.error({ err, workspace: workspaceId, segment: seg.id }, 'segment refresh failed; continuing with the next segment');
    await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`)).catch(() => {});
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`)).catch(() => {});
    return null;
  }
}
