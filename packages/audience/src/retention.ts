import type { Db } from '@agentic-marketing/db';
import type { EventStore, StoredEvent } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { PLATFORM_EVENT, PLATFORM_EVENTS } from '@agentic-marketing/ingest';
import { removeProfiles } from '@agentic-marketing/profiles';
import { logger } from '@agentic-marketing/telemetry';
import { sql } from 'drizzle-orm';

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
/**
 * Candidates examined per round. A cursor carries the position across rounds, so a large set of
 * kept profiles cannot starve an eligible signup behind them (P2-2).
 */
const CANDIDATE_BATCH = 200;
const CURSOR_KEY = 'retention:unconfirmed-cursor';
/** Long enough that a quiet workspace's cursor survives until the next hourly round. */
const CURSOR_TTL_SECONDS = 30 * 24 * 3600;
const PLATFORM_NAMES = new Set(PLATFORM_EVENTS);

interface Cursor {
  createdAt: string;
  id: string;
}

interface Candidate {
  workspace_id: string;
  id: string;
  /** PostgreSQL's full microsecond precision, formatted as text so the driver cannot round it. */
  created_at: string;
  anonymous_ids: string[];
}

/**
 * Whether these are only the events a form submission itself produces: the signup, the
 * confirmation (never deleted anyway), and the platform's own e-mail outcomes. The person's form
 * identify carries the submission timestamp; any other event, from any source, is activity and
 * keeps the profile. An empty or unreadable history proves nothing and also keeps it (P2-1).
 */
function onlyFormActivity(events: StoredEvent[]): boolean {
  if (!events.length || events.length >= EVENT_WINDOW) return false;
  if (events.some((e) => e.name === PLATFORM_EVENT.subscriptionConfirmed)) return false;
  // The form's own identify came from the form source at the submission timestamp. The source id
  // is set by the ingest path (the form id `frm_…`), not by the request body, so a client identify
  // that merely shares the timestamp does not count as the form's (P3).
  const submissions = events.filter((e) => e.type === 'track' && e.name === PLATFORM_EVENT.formSubmitted);
  if (!submissions.length) return false;
  const submitted = new Set(submissions.map((e) => `${e.sourceId}:${e.timestamp}`));
  return events.every((e) => PLATFORM_NAMES.has(e.name) || (e.type === 'identify' && submitted.has(`${e.sourceId}:${e.timestamp}`)));
}

async function readCursor(deps: RetentionDeps): Promise<Cursor | null> {
  if (!deps.hot) return null;
  try {
    const raw = await deps.hot.cached(CURSOR_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Cursor>;
    return typeof value.createdAt === 'string' && typeof value.id === 'string' ? { createdAt: value.createdAt, id: value.id } : null;
  } catch (err) {
    logger.warn({ err }, 'retention cursor not read');
    return null;
  }
}

async function writeCursor(deps: RetentionDeps, cursor: Cursor | null) {
  if (!deps.hot) return;
  try {
    if (cursor) await deps.hot.cache(CURSOR_KEY, JSON.stringify(cursor), CURSOR_TTL_SECONDS);
    else await deps.hot.cache(CURSOR_KEY, '', 1);
  } catch (err) {
    logger.warn({ err }, 'retention cursor not saved');
  }
}

/**
 * The SQL can narrow to people with one e-mail and one anonymous id and no user id. Imported
 * people without a user id are recognisable by their `import:` anonymous id and excluded. API and
 * SDK profiles have no durable source field on the profile or identifier, so they remain
 * candidates; the event check keeps them, and the cursor ensures they cannot starve real signups.
 */
async function candidates(deps: RetentionDeps, cursor: Cursor | null): Promise<Candidate[]> {
  const { rows } = await deps.db.admin.query<Candidate>(
    `SELECT p.workspace_id, p.id,
            to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            ARRAY(SELECT a.value FROM identifiers a
                  WHERE a.workspace_id = p.workspace_id AND a.profile_id = p.id AND a.type = 'anonymous_id') AS anonymous_ids
     FROM profiles p
     WHERE p.merged_into IS NULL AND p.first_seen < now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.workspace_id = p.workspace_id AND c.profile_id = p.id)
       AND EXISTS (SELECT 1 FROM identifiers e WHERE e.workspace_id = p.workspace_id AND e.profile_id = p.id AND e.type = 'email')
       AND NOT EXISTS (SELECT 1 FROM identifiers u WHERE u.workspace_id = p.workspace_id AND u.profile_id = p.id AND u.type = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM identifiers imp WHERE imp.workspace_id = p.workspace_id AND imp.profile_id = p.id
                       AND imp.type = 'anonymous_id' AND imp.value LIKE 'import:%')
       AND NOT EXISTS (SELECT 1 FROM identifiers o WHERE o.workspace_id = p.workspace_id AND o.profile_id = p.id
                       AND o.type NOT IN ('anonymous_id', 'email', 'phone'))
       AND (SELECT count(*) FROM identifiers a WHERE a.workspace_id = p.workspace_id AND a.profile_id = p.id
            AND a.type = 'anonymous_id') = 1
       AND NOT EXISTS (SELECT 1 FROM profile_merges m WHERE m.workspace_id = p.workspace_id AND m.into_id = p.id)
       AND ($2::timestamptz IS NULL OR (p.created_at, p.id) > ($2::timestamptz, $3::text))
     ORDER BY p.created_at, p.id
     LIMIT $4`,
    [deps.unconfirmedDays, cursor?.createdAt ?? null, cursor?.id ?? '', CANDIDATE_BATCH],
  );
  return rows;
}

/** One ClickHouse query per workspace for the whole candidate batch, at most EVENT_WINDOW per person. */
async function historyOf(deps: RetentionDeps, candidates: Candidate[]) {
  const history = new Map<string, StoredEvent[]>();
  const byWorkspace = new Map<string, string[]>();
  for (const c of candidates) {
    const anon = c.anonymous_ids[0];
    if (!anon) continue;
    byWorkspace.set(c.workspace_id, [...(byWorkspace.get(c.workspace_id) ?? []), anon]);
  }
  for (const [workspaceId, anonymousIds] of byWorkspace) {
    try {
      const events = await deps.events.eventsOfAnonymousIds(workspaceId, anonymousIds, EVENT_WINDOW);
      for (const e of events) {
        const key = `${workspaceId}:${e.anonymousId}`;
        history.set(key, [...(history.get(key) ?? []), e]);
      }
    } catch (err) {
      // The sink may be behind or ClickHouse unavailable: every candidate in this workspace has
      // no proof this round, so it is kept and looked at again next round.
      logger.warn({ err, workspaceId }, 'retention: event history not read; keeping candidates');
    }
  }
  return history;
}

/**
 * Deletes only while the profile is still the one that was selected. `FOR UPDATE` on the profile
 * row serialises with consent and identifier writes: the app's consent writer inserts the ledger
 * row and then `consent_state`, whose foreign key takes a key-share lock on this profile. If that
 * writer commits first, the lock waits and the re-check sees the consent; if the delete wins, the
 * writer's transaction rolls back instead of recording consent on a deleted person. A committed
 * consent row or a new identifier always keeps the profile.
 */
async function removeUnconfirmedSignup(deps: RetentionDeps, candidate: Candidate): Promise<boolean> {
  let removed = false;
  await deps.db.withWorkspace(candidate.workspace_id, async (tx) => {
    const locked = await tx.execute<{ id: string }>(sql`
      SELECT id FROM profiles
      WHERE workspace_id = ${candidate.workspace_id} AND id = ${candidate.id} AND merged_into IS NULL
      FOR UPDATE`);
    if (!locked.rows.length) return;
    const anon = candidate.anonymous_ids[0] ?? '';
    const recheck = await tx.execute<{ blocked: boolean }>(sql`
      SELECT (
        EXISTS (SELECT 1 FROM consent_records c
                WHERE c.workspace_id = ${candidate.workspace_id} AND c.profile_id = ${candidate.id})
        OR NOT EXISTS (SELECT 1 FROM identifiers e
                       WHERE e.workspace_id = ${candidate.workspace_id} AND e.profile_id = ${candidate.id} AND e.type = 'email')
        OR EXISTS (SELECT 1 FROM identifiers u
                   WHERE u.workspace_id = ${candidate.workspace_id} AND u.profile_id = ${candidate.id} AND u.type = 'user_id')
        OR EXISTS (SELECT 1 FROM identifiers o
                   WHERE o.workspace_id = ${candidate.workspace_id} AND o.profile_id = ${candidate.id}
                     AND o.type NOT IN ('anonymous_id', 'email', 'phone'))
        OR (SELECT count(*) FROM identifiers a
            WHERE a.workspace_id = ${candidate.workspace_id} AND a.profile_id = ${candidate.id} AND a.type = 'anonymous_id') <> 1
        OR NOT EXISTS (SELECT 1 FROM identifiers a
                       WHERE a.workspace_id = ${candidate.workspace_id} AND a.profile_id = ${candidate.id}
                         AND a.type = 'anonymous_id' AND a.value = ${anon})
      ) AS blocked`);
    if (recheck.rows[0]?.blocked) return;
    await removeProfiles(tx, candidate.workspace_id, [candidate.id], deps, { suppress: false });
    removed = true;
  });
  return removed;
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
  // anonymous id no longer hides an unconfirmed signup from this query (#627). A cursor pages
  // through the candidates in created_at/id order, so kept profiles cannot hide an eligible one.
  const cursor = await readCursor(deps);
  let rows = await candidates(deps, cursor);
  if (!rows.length && cursor) {
    // The end of the ordered set: wrap so the next scan starts at the oldest candidate again.
    await writeCursor(deps, null);
    rows = await candidates(deps, null);
  }
  const history = await historyOf(deps, rows);
  let profiles = 0;
  for (const r of rows) {
    const events = history.get(`${r.workspace_id}:${r.anonymous_ids[0]}`) ?? [];
    // Positive evidence only. No form submission, a confirmation, other activity, an empty or an
    // unreadable history all mean the profile stays.
    if (!onlyFormActivity(events)) continue;
    try {
      if (await removeUnconfirmedSignup(deps, r)) profiles++;
    } catch (err) {
      logger.warn({ err, profile: r.id }, 'retention: unconfirmed signup not removed');
    }
  }
  const last = rows.at(-1);
  if (rows.length === CANDIDATE_BATCH && last) await writeCursor(deps, { createdAt: last.created_at, id: last.id });
  else await writeCursor(deps, null);
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
