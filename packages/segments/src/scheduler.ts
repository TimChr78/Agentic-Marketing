import type { Db } from '@agentic-marketing/db';
import { schema } from '@agentic-marketing/db';
import type { BusEvent, EventBus, EventStore } from '@agentic-marketing/events';
import { logger } from '@agentic-marketing/telemetry';
import { publishedSegments, publishInSlices, refreshSegment } from './membership';

/**
 * Scheduler role: recomputes segments whose published version changed right away, and every
 * segment periodically, so time windows ("in the last 7 days") also make people leave.
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
    try {
      const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace_id FROM artifacts WHERE type = 'segment' AND published_version IS NOT NULL AND NOT archived`,
      );
      for (const { workspace_id: ws } of rows) {
        await deps.db
          .withWorkspace(ws, async (tx) => {
            const all = await publishedSegments(tx);
            const runs = new Map((await tx.select().from(schema.segmentRuns)).map((r) => [r.segmentId, r]));
            const out: BusEvent[] = [];
            const changed = new Set<string>();
            for (const seg of all) {
              const last = runs.get(seg.id);
              if (last && last.version === seg.version && Date.now() - last.at.getTime() < every) continue;
              const r = await refreshSegment(tx, ws, seg, deps.events, all);
              logger.info(
                { workspace: ws, segment: seg.id, members: r.members, entered: r.entered, exited: r.exited },
                'segment recomputed',
              );
              for (const e of r.changes) out.push(e);
              for (const p of r.changedProfiles) changed.add(p);
            }
            await publishInSlices(deps.bus, out);
            return [...changed];
          })
          .then((changed) => (changed.length && deps.afterRefresh ? deps.afterRefresh(ws, changed) : undefined));
      }
    } catch (err) {
      logger.error({ err }, 'segment scheduler round failed');
    }
    await new Promise((r) => setTimeout(r, deps.tickMs ?? 30_000));
  }
}
