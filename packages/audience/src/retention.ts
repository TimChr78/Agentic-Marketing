import type { Db } from '@agentic-marketing/db';
import type { EventStore, StoredEvent } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { PLATFORM_EVENT, PLATFORM_EVENTS } from '@agentic-marketing/ingest';
import { removeProfiles } from '@agentic-marketing/profiles';
import { logger } from '@agentic-marketing/telemetry';

// Retention (scheduler role): data is kept only as long as it has a purpose.
// - Signups that were never confirmed: people known only through a form submission, with no
//   consent recorded and no activity of their own, are removed after `unconfirmedDays`. Without
//   suppression, so they can sign up again later.
// - Operational logs: finished webhook and action deliveries and AI calls after `logDays`.
// - Finished hosted-agent runs after `hostedAgentRunDays` (default 90): the run history and failure
//   queue are recent-window reads, so old rows are not kept (#488).
// - Unknown input-key evidence after 30 days: recent behaviour is what a strict-mode rollout needs.

export interface RetentionDeps {
  db: Db;
  events: EventStore;
  hot?: HotState;
  unconfirmedDays: number;
  logDays: number;
  /** Days finished hosted-agent runs are kept; defaults to 90 when a caller does not configure it. */
  hostedAgentRunDays?: number;
  /** Hours after an erasure that identifiers stay blocked (#210); tombstones live this plus 7 days. */
  erasureGraceHours?: number;
}

/** Evidence for STRICT_INPUTS is only useful for a recent rollout window (#124). */
const INPUT_WARNING_DAYS = 30;
/** Tombstones outlive the grace window by this much, so a clock or replay near it is still covered. */
const TOMBSTONE_EXTRA_DAYS = 7;

/** How many events one candidate is inspected for; a longer history is activity and is kept. */
const EVENT_WINDOW = 100;
const PLATFORM_NAMES = new Set(PLATFORM_EVENTS);

/**
 * Whether these are only the events a form submission itself produces: the signup, the
 * confirmation (never deleted anyway), and the platform's own e-mail outcomes. The person's form
 * identify carries the submission timestamp; any other event, from any source, is activity and
 * keeps the profile. Records created before this check existed still work: the form submission is
 * found by its stored event, not by the shape of the client's anonymous id (#627).
 */
function onlyFormActivity(events: StoredEvent[]): boolean {
  if (!events.length || events.length >= EVENT_WINDOW) return false;
  if (events.some((e) => e.name === PLATFORM_EVENT.subscriptionConfirmed)) return false;
  const submittedAt = new Set(events.filter((e) => e.type === 'track' && e.name === PLATFORM_EVENT.formSubmitted).map((e) => e.timestamp));
  if (!submittedAt.size) return false;
  return events.every((e) => PLATFORM_NAMES.has(e.name) || (e.type === 'identify' && submittedAt.has(e.timestamp)));
}

export async function runRetentionOnce(deps: RetentionDeps): Promise<{
  profiles: number;
  deliveries: number;
  aiCalls: number;
  inputWarnings: number;
  erasureTombstones: number;
  profileScores: number;
  hostedAgentRuns: number;
}> {
  // A form signup is one e-mail and one anonymous id (the client's `am.uid` when the form sent
  // one, otherwise the form's own `form:<uuid>`), with no user id and no other identifier. The
  // event store then decides whether it is a form submission with no other activity, so a client
  // anonymous id no longer hides an unconfirmed signup from this query (#627).
  const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string; anonymous_ids: string[] }>(
    `SELECT p.workspace_id, p.id,
            ARRAY(SELECT a.value FROM identifiers a
                  WHERE a.workspace_id = p.workspace_id AND a.profile_id = p.id AND a.type = 'anonymous_id') AS anonymous_ids
     FROM profiles p
     WHERE p.merged_into IS NULL AND p.first_seen < now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.workspace_id = p.workspace_id AND c.profile_id = p.id)
       AND EXISTS (SELECT 1 FROM identifiers e WHERE e.workspace_id = p.workspace_id AND e.profile_id = p.id AND e.type = 'email')
       AND NOT EXISTS (SELECT 1 FROM identifiers u WHERE u.workspace_id = p.workspace_id AND u.profile_id = p.id AND u.type = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM identifiers o WHERE o.workspace_id = p.workspace_id AND o.profile_id = p.id
                       AND o.type NOT IN ('anonymous_id', 'email', 'phone'))
       AND (SELECT count(*) FROM identifiers a WHERE a.workspace_id = p.workspace_id AND a.profile_id = p.id
            AND a.type = 'anonymous_id') = 1
       AND NOT EXISTS (SELECT 1 FROM profile_merges m WHERE m.workspace_id = p.workspace_id AND m.into_id = p.id)
     LIMIT 500`,
    [deps.unconfirmedDays],
  );
  let profiles = 0;
  for (const r of rows) {
    try {
      const events = await deps.events.eventsOf(r.workspace_id, { anonymousIds: r.anonymous_ids, userIds: [] }, { limit: EVENT_WINDOW });
      // Not a form signup, or it has done something of its own: never delete it. When the sink has
      // not caught up, a profile whose only anonymous id is the form's own `form:<uuid>` id is
      // still the same signup the old identifier-shape rule recognised; nothing non-platform may
      // be visible for it. A read failure keeps the profile, so a ClickHouse outage cannot turn
      // into a deletion.
      const formShaped = r.anonymous_ids.length === 1 && r.anonymous_ids[0]?.startsWith('form:');
      const deletable = onlyFormActivity(events) || (!!formShaped && events.every((e) => PLATFORM_NAMES.has(e.name)));
      if (!deletable) continue;
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
  // Scope by workspace to use (workspace_id, expires_at), and bound each transaction.
  let profileScoreCount = 0;
  const workspaces = await deps.db.admin.query<{ id: string }>('SELECT id FROM workspaces');
  for (const { id } of workspaces.rows) {
    const removed = await deps.db.admin.query(
      `DELETE FROM profile_scores WHERE workspace_id = $1 AND (profile_id, key) IN (
         SELECT profile_id, key FROM profile_scores WHERE workspace_id = $1 AND expires_at <= now()
         ORDER BY expires_at LIMIT 5000
       )`,
      [id],
    );
    profileScoreCount += removed.rowCount ?? 0;
  }
  const profileScores = { rowCount: profileScoreCount };
  const inputWarnings = await deps.db.admin.query(`DELETE FROM input_warnings WHERE last_seen < now() - make_interval(days => $1)`, [
    INPUT_WARNING_DAYS,
  ]);
  // Tombstones only need to outlast the window in which they drop events (#210).
  const erasureTombstones = await deps.db.admin.query(
    `DELETE FROM erasure_tombstones WHERE erased_at < now() - make_interval(hours => $1)`,
    [(deps.erasureGraceHours ?? 24) + TOMBSTONE_EXTRA_DAYS * 24],
  );
  // Hosted-agent runs are terminal rows (ok, failed or skipped); the run history and failure queue
  // read a recent window, so older rows are removed (#488).
  const hostedAgentRuns = await deps.db.admin.query(`DELETE FROM hosted_agent_runs WHERE started_at < now() - make_interval(days => $1)`, [
    deps.hostedAgentRunDays ?? 90,
  ]);
  if (
    profiles ||
    deliveries.rowCount ||
    aiCalls.rowCount ||
    profileScores.rowCount ||
    inputWarnings.rowCount ||
    erasureTombstones.rowCount ||
    hostedAgentRuns.rowCount
  )
    logger.info(
      {
        profiles,
        deliveries: deliveries.rowCount,
        aiCalls: aiCalls.rowCount,
        profileScores: profileScores.rowCount,
        inputWarnings: inputWarnings.rowCount,
        erasureTombstones: erasureTombstones.rowCount,
        hostedAgentRuns: hostedAgentRuns.rowCount,
      },
      'retention removed old data',
    );
  return {
    profiles,
    deliveries: deliveries.rowCount ?? 0,
    aiCalls: aiCalls.rowCount ?? 0,
    profileScores: profileScores.rowCount ?? 0,
    inputWarnings: inputWarnings.rowCount ?? 0,
    erasureTombstones: erasureTombstones.rowCount ?? 0,
    hostedAgentRuns: hostedAgentRuns.rowCount ?? 0,
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
