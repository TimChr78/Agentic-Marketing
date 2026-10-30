import type { Db } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { removeProfiles } from '@agentic-marketing/profiles';
import { logger } from '@agentic-marketing/telemetry';

// Retention (scheduler role): data is kept only as long as it has a purpose.
// - Signups that were never confirmed: people known only through a form submission, with no
//   consent recorded, are removed after `unconfirmedDays`. Without suppression, so they can
//   sign up again later.
// - Operational logs: finished webhook and action deliveries and AI calls after `logDays`.
// - Unknown input-key evidence after 30 days: recent behaviour is what a strict-mode rollout needs.

export interface RetentionDeps {
  db: Db;
  events: EventStore;
  hot?: HotState;
  unconfirmedDays: number;
  logDays: number;
  /** Hours after an erasure that identifiers stay blocked (#210); tombstones live this plus 7 days. */
  erasureGraceHours?: number;
}

/** Evidence for STRICT_INPUTS is only useful for a recent rollout window (#124). */
const INPUT_WARNING_DAYS = 30;
/** Tombstones outlive the grace window by this much, so a clock or replay near it is still covered. */
const TOMBSTONE_EXTRA_DAYS = 7;

export async function runRetentionOnce(
  deps: RetentionDeps,
): Promise<{ profiles: number; deliveries: number; aiCalls: number; inputWarnings: number; erasureTombstones: number }> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
    `SELECT p.workspace_id, p.id FROM profiles p
     WHERE p.merged_into IS NULL AND p.first_seen < now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.workspace_id = p.workspace_id AND c.profile_id = p.id)
       AND EXISTS (SELECT 1 FROM identifiers i WHERE i.workspace_id = p.workspace_id AND i.profile_id = p.id
                   AND i.type = 'anonymous_id' AND i.value LIKE 'form:%')
       AND NOT EXISTS (SELECT 1 FROM identifiers i WHERE i.workspace_id = p.workspace_id AND i.profile_id = p.id
                   AND (i.type = 'user_id' OR (i.type = 'anonymous_id' AND i.value NOT LIKE 'form:%')))
       AND NOT EXISTS (SELECT 1 FROM profile_merges m WHERE m.workspace_id = p.workspace_id AND m.into_id = p.id)
     LIMIT 500`,
    [deps.unconfirmedDays],
  );
  let profiles = 0;
  for (const r of rows) {
    try {
      await deps.db.withWorkspace(r.workspace_id, (tx) => removeProfiles(tx, r.workspace_id, [r.id], deps, { suppress: false }));
      profiles++;
    } catch (err) {
      logger.warn({ err, profile: r.id }, 'retention: unconfirmed signup not removed');
    }
  }
  const deliveries = await deps.db.admin.query(
    `DELETE FROM deliveries WHERE status IN ('done', 'failed', 'dead') AND created_at < now() - make_interval(days => $1)`,
    [deps.logDays],
  );
  const aiCalls = await deps.db.admin.query(
    `DELETE FROM ai_calls WHERE status IN ('done', 'fallback', 'failed') AND created_at < now() - make_interval(days => $1)`,
    [deps.logDays],
  );
  const inputWarnings = await deps.db.admin.query(`DELETE FROM input_warnings WHERE last_seen < now() - make_interval(days => $1)`, [
    INPUT_WARNING_DAYS,
  ]);
  // Tombstones only need to outlast the window in which they drop events (#210).
  const erasureTombstones = await deps.db.admin.query(
    `DELETE FROM erasure_tombstones WHERE erased_at < now() - make_interval(hours => $1)`,
    [(deps.erasureGraceHours ?? 24) + TOMBSTONE_EXTRA_DAYS * 24],
  );
  if (profiles || deliveries.rowCount || aiCalls.rowCount || inputWarnings.rowCount || erasureTombstones.rowCount)
    logger.info(
      {
        profiles,
        deliveries: deliveries.rowCount,
        aiCalls: aiCalls.rowCount,
        inputWarnings: inputWarnings.rowCount,
        erasureTombstones: erasureTombstones.rowCount,
      },
      'retention removed old data',
    );
  return {
    profiles,
    deliveries: deliveries.rowCount ?? 0,
    aiCalls: aiCalls.rowCount ?? 0,
    inputWarnings: inputWarnings.rowCount ?? 0,
    erasureTombstones: erasureTombstones.rowCount ?? 0,
  };
}

export async function runRetention(deps: RetentionDeps, signal: AbortSignal, tickMs = 3_600_000) {
  while (!signal.aborted) {
    await runRetentionOnce(deps).catch((err) => logger.error({ err }, 'retention round failed'));
    await new Promise<void>((r) => {
      const timer = setTimeout(r, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
}
