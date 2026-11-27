import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type {} from '@agentic-marketing/commands';
import { logger } from '@agentic-marketing/telemetry';
import { type ClickHouseClient, createClient, TupleParam } from '@clickhouse/client';
import { messageEventsWithPending } from './pending';
import { personReadSource } from './protected';
import { eventCorrelation, normalizeEvent, unreadableEventReason } from './readable';
import type { BusEvent } from './schema';
import {
  type ErasedSubjectRow,
  eventClickIds,
  noteSubjectKeyFailure,
  SUBJECT_KEY_BACKFILL_TABLES,
  SUBJECT_KEY_COLUMNS,
  SUBJECT_KEY_KINDS,
  type SubjectCoverage,
  type SubjectKeyBackfillOptions,
  type SubjectKeyBackfillResult,
  type SubjectKeyCoverageResult,
  type SubjectKeyHasherFactory,
  type SubjectKeyHashes,
  type SubjectKeyKind,
} from './subjectKeys';

// ClickHouse is the event store. This module is the only place that talks to it, and every
// query it offers is scoped to one workspace. Row policies (see applyRowPolicies) enforce that
// too: a query sees only the rows of the workspace in its SQL_workspace setting, and none without.

const MIGRATIONS = new URL('../clickhouse/', import.meta.url);

/**
 * Client options for a configured URL. The ClickHouse client authenticates from the URL userinfo
 * itself, but it decodes it and sends Basic itself; keeping the userinfo in the URL passed to the
 * client also means an error can repeat it. Move the percent-decoded credentials to the client's
 * own username/password options, which is how the client builds the same Basic header, and give it
 * a URL without userinfo (#931 round 3). The path, query parameters and their precedence over these
 * options are unchanged.
 */
function clientOptions(url: string) {
  const parsed = new URL(url);
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.username = '';
  parsed.password = '';
  return {
    url: parsed.toString(),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

export interface ConversionEvent {
  profileId: string;
  anonymousId: string;
  userId: string;
  name: string;
  timestamp: number;
  properties: Record<string, unknown>;
}

/** One participant's first take of a split node, with the arm it selected. */
export interface JourneySplitArm {
  participantId: number;
  profileId: string;
  arm: number;
  at: number;
}

export interface EventStore {
  /**
   * Stores the readable events of a batch and returns how many rows it wrote. A record the store
   * itself cannot turn into a row is dropped and logged, not counted as stored.
   */
  insert(events: BusEvent[]): Promise<number>;
  /**
   * Events of a person, by every anonymous id and user id they are known by. Newest first.
   * Pages with the full replacing key `(timestamp, name, anonymous_id, event_id)`. A cursor
   * without `beforeName` or `beforeAnonymousId` is a pre-#840 cursor: it falls back to the old
   * `(timestamp, event_id)` tuple, which always makes progress and may skip rows that tie on both
   * (exactly as before #840) rather than returning the same page forever.
   */
  eventsOf(
    workspaceId: string,
    ids: { anonymousIds: string[]; userIds: string[] },
    opts?: {
      limit?: number;
      before?: string;
      beforeId?: string;
      beforeName?: string;
      beforeAnonymousId?: string;
    },
  ): Promise<StoredEvent[]>;
  /** The newest `perId` events for each of several anonymous ids in one query (bounded retention scans). */
  eventsOfAnonymousIds(workspaceId: string, anonymousIds: string[], perId: number): Promise<StoredEvent[]>;
  /** Deletes a person's events (erasure). */
  deleteEventsOf(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[]; profileIds?: string[] }): Promise<void>;
  /**
   * The recurring physical purge (#1037 part 3): deletes stored rows whose effective subject keys
   * match any retained exclusion key, per person-linked table, in bounded batches. It uses the same
   * keyed matching as the protected views (including `events.profile_id`, through its subject
   * hash), never the raw identifiers and never the ledger or selector rows themselves. `complete`
   * is false when the batch bound was reached with matching rows left, or when `checkpoint` reports
   * that the caller's claim was lost. `checkpoint` runs between batches and tables, before each
   * mutation; returning false stops the sweep without another delete.
   */
  purgeErasedSubjects(
    workspaceId: string,
    keys: readonly string[],
    opts?: { batchSize?: number; maxBatches?: number; checkpoint?: () => Promise<boolean> },
  ): Promise<{ deleted: number; complete: boolean; tables: { table: string; deleted: number; remaining: boolean }[] }>;
  /** Matching events per identifier (segments): name, property equality, time window, optional id scope. */
  countEvents(
    workspaceId: string,
    q: {
      name: string;
      where?: Record<string, string | number | boolean>;
      sinceSeconds?: number;
      ids?: { anonymousIds: string[]; userIds: string[] };
      excludeEventIds?: string[];
    },
  ): Promise<{ anonymousId: string; userId: string; count: number }[]>;
  /** The same counts for a whole workspace, streamed in batches (segment refreshes over millions of people). */
  countEventsBatches(
    workspaceId: string,
    q: { name: string; where?: Record<string, string | number | boolean>; sinceSeconds?: number },
    batchSize?: number,
  ): AsyncIterable<{ anonymousId: string; userId: string; count: number }[]>;
  /**
   * Per-profile counts of what happened to the messages the platform sent (#441): a segment counts
   * opens and clicks here, because those are message events, not customer events. Rows carry the
   * profile id the send recorded; the caller resolves merges.
   */
  countMessageEvents(workspaceId: string, q: MessageEventCountQuery): Promise<{ profileId: string; count: number }[]>;
  /** The same counts for a whole workspace, streamed in batches (segment refreshes over millions of people). */
  countMessageEventsBatches(
    workspaceId: string,
    q: MessageEventCountQuery,
    batchSize?: number,
  ): AsyncIterable<{ profileId: string; count: number }[]>;
  /**
   * Per variant: visitors exposed to an experience, and how many did the goal event after their
   * first exposure. `unversioned` is the number of distinct visitors whose exposure carries no
   * version, which the per-version counts exclude (#758).
   */
  experimentCounts(
    workspaceId: string,
    q: { experienceId: string; version: number; goal?: string; since?: Date },
  ): Promise<{ variants: { variant: string; exposed: number; converted: number }[]; unversioned: number }>;
  insertMessageEvents(events: MessageEvent[], opts?: MessageEventPublishOptions): Promise<void>;
  insertJourneyEvents(events: JourneyEvent[]): Promise<void>;
  /**
   * Publishes erasure exclusions into `erased_subjects` (#1037 part 1). Idempotent: the table
   * replaces on (workspace, kind, key), so republishing the committed ledger changes nothing.
   */
  publishErasedSubjects(rows: ErasedSubjectRow[]): Promise<void>;
  /** The workspace's published exclusion hashes, as one FINAL read (never the raw identifiers). */
  erasedSubjectKeys(workspaceId: string): Promise<Set<string>>;
  /**
   * Whether a read of this workspace must use the protected views (#1037 part 2). False only when
   * the durable `erasure_keys` ledger has no row for the workspace, so nothing has ever been
   * recorded to exclude. Never cached as a stale "no": the ledger is read per request (or through
   * a positive-only cache), so a read after an erasure's SQL commit always takes the protected
   * path, even before its publication reaches ClickHouse.
   */
  hasErasures(workspaceId: string): Promise<boolean>;
  /**
   * Confirms a publication is visible: every key in `keys` must be present in a FINAL read. Used
   * by the erasure cleanup before it records the published generation (#1037 part 2).
   */
  erasedSubjectsVisible(workspaceId: string, keys: readonly string[]): Promise<boolean>;
  /**
   * Drops pending message events whose profile is an erased subject (#1037 part 2). The union half
   * of a metric snapshot never reaches ClickHouse before publication, so it is checked here with
   * the same keyed hash a writer stores. Without an exclusion-key hasher the call fails closed
   * when the workspace actually has erasures; with none there is nothing to exclude.
   */
  withoutErasedSubjects(workspaceId: string, events: readonly MessageEvent[]): Promise<MessageEvent[]>;
  /**
   * One step of the historical subject-key backfill (#1037 part 1): reads each workspace's next
   * batch of unprocessed rows, hashes their identifiers in the app and writes them back. Resumable
   * and idempotent; `done` only when a FINAL count of unprocessed rows is zero.
   */
  backfillSubjectKeys(opts: SubjectKeyBackfillOptions): Promise<SubjectKeyBackfillResult>;
  /** Historical rows that still lack subject coverage (the `am doctor` and PR 3 activation count). */
  subjectKeyCoverage(workspaceIds: readonly string[]): Promise<SubjectKeyCoverageResult>;
  /**
   * Unique messages per event type since a time, optionally for one template or journey. A caller
   * that must decide before the outbox published can pass the queued events: the same aggregation
   * then reads published rows plus that snapshot (#1008).
   */
  messageStats(
    workspaceId: string,
    q: {
      since: Date;
      until?: Date;
      templateId?: string;
      journeyId?: string;
      messageIds?: string[];
      /** Subject-test variant, matched on `message_events.variant` (#1153). */
      variant?: string;
      pendingEvents?: readonly MessageEvent[];
    },
  ): Promise<Record<string, number>>;
  /**
   * Unique message events per subject-test variant for one broadcast, aggregated in ClickHouse.
   * Reads by `journey_id`, so a large subject test never sends its message ids as a parameter
   * (#1153).
   */
  messageVariantStats(
    workspaceId: string,
    journeyId: string,
  ): Promise<Record<string, { delivered: number; opened: number; clicked: number }>>;
  /** Per node and event type counts for a journey (analytics, canvas overlays). */
  journeyCounts(workspaceId: string, journeyId: string): Promise<{ node: string; type: string; count: number }[]>;
  /**
   * Profiles that reached the journey's goal or unsubscribed from its e-mail, in a time window.
   * Pass `profileIds` to scope the read to one page of people (and their merged-away ids); the
   * holdout report does that, so its memory is a page rather than the journey's whole history.
   */
  journeyHoldoutOutcomes(
    workspaceId: string,
    q: { journeyId: string; from?: Date; to?: Date; profileIds?: string[] },
  ): Promise<{
    converted: string[];
    unsubscribed: string[];
    /** The same outcomes with their timestamps, so a split result can attribute each one once. */
    convertedAt: { profileId: string; participantId: number | null; at: number }[];
    unsubscribedAt: { profileId: string; at: number }[];
  }>;
  /**
   * Which arm of a split node each participant took (the step's detail, "variant N"), for split
   * results (#313). Pass `onPage` to walk it one page of participants at a time, in participant-id
   * order, so a split with a large history is never one read (#1108); the pages are at most
   * `pageSize` entries and the method returns []. Without `onPage` the historical unbounded read
   * is kept.
   */
  journeySplitArms(
    workspaceId: string,
    q: {
      journeyId: string;
      node: string;
      from?: Date;
      to?: Date;
      onPage?: (rows: JourneySplitArm[]) => void | Promise<void>;
      /** Entries per page when `onPage` is used. Defaults to 10,000. */
      pageSize?: number;
    },
  ): Promise<JourneySplitArm[]>;
  /**
   * Goal events by name in a time window, with the identifiers that tie them to a profile. Every
   * matching event is returned: the query pages with a stable keyset over the table's full
   * replacing key (timestamp, name, anonymous_id, event_id) instead of applying a workspace-wide
   * limit (#366, #786). Pass profileIds/identifiers to scope it to the people being measured.
   */
  conversionEvents(
    workspaceId: string,
    q: {
      names: string[];
      from: Date;
      to: Date;
      profileIds?: string[];
      identifiers?: { anonymousIds: string[]; userIds: string[] };
      /**
       * Consume each page as it is read instead of accumulating the whole window. The caller folds
       * the page into its own totals, so a busy window never has to fit in memory and a caller
       * that looks up per-visitor data can do so for one bounded page at a time (#786).
       */
      onPage?: (rows: ConversionEvent[]) => void | Promise<void>;
      /** Rows per keyset page when `onPage` is used. Defaults to 10,000. */
      pageSize?: number;
    },
  ): Promise<ConversionEvent[]>;
  /** People who unsubscribed from any message sent by these journeys or broadcasts, in a time window. */
  unsubscribedProfiles(workspaceId: string, q: { journeyIds: string[]; from?: Date; to?: Date; profileIds?: string[] }): Promise<string[]>;
  messageEventsOf(workspaceId: string, filter: { messageIds?: string[]; profileId?: string }, limit?: number): Promise<MessageEvent[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  /** Settings to pass with a query of one workspace through `client` (the row policies need them). */
  settingsFor(workspaceId: string): Promise<Record<string, string>>;
  readonly client: ClickHouseClient;
}

export const ROW_POLICY = 'am_workspace';

/**
 * Client-side bound on every ClickHouse request. The erasure cleanup uses it to choose a fixed
 * interval between its two sweeps; it is not proof that the ClickHouse server stopped executing a
 * write, and a late write can still land. Read-time exclusion (#1037) is the full contract.
 */
export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Person-linked inserts are synchronous. Without this a ClickHouse server with async inserts
 * enabled could acknowledge a batch before it is committed. A resolved insert here means
 * ClickHouse responded, though a client timeout still does not prove the server stopped executing.
 */
const SYNC_INSERT = { async_insert: 0, wait_for_async_insert: 1 } as const;

const SCOPED_TABLES = ['events', 'message_events', 'journey_events', 'ad_spend', 'erased_subjects', 'subject_key_backfill'];

/**
 * Row policies: every table with a workspace_id returns only the rows of the workspace named in
 * the query's SQL_workspace setting, so a query that forgets its workspace filter sees nothing
 * rather than every workspace. Needs a user with access management and the SQL_ prefix for custom
 * settings (the reference compose file and Helm chart set both). `auto` applies them when it can.
 */
export async function applyRowPolicies(
  client: ClickHouseClient,
  database: string,
  mode: 'required' | 'auto' | 'off',
  log: (m: string) => void = () => {},
) {
  if (mode === 'off') {
    for (const t of SCOPED_TABLES) await client.command({ query: `DROP ROW POLICY IF EXISTS ${ROW_POLICY} ON ${database}.${t}` });
    return false;
  }
  // A failed probe is not an answer about custom settings: a refused connection, reset socket or
  // timeout says nothing about `SQL_`, and treating it as "not accepted" would leave the policies
  // unapplied for good (#1225). Fail so the migration can be retried once ClickHouse answers.
  let accepts: boolean;
  try {
    accepts = await acceptsWorkspaceSetting(client);
  } catch (err) {
    throw new Error(
      `ClickHouse row policies could not be applied: the server did not answer the SQL_ setting probe (${(err as Error).message.split('\n')[0]}). Retry once ClickHouse is reachable.`,
      { cause: err },
    );
  }
  if (!accepts) {
    const why = 'ClickHouse row policies could not be applied: the server does not accept SQL_ custom settings (custom_settings_prefixes)';
    if (mode === 'required') throw new Error(`${why}. Grant the user access management, or set CLICKHOUSE_ROW_POLICIES=auto.`);
    log(`${why}; queries are still filtered by workspace in code`);
    return false;
  }
  try {
    for (const t of SCOPED_TABLES)
      await client.command({
        query: `CREATE ROW POLICY OR REPLACE ${ROW_POLICY} ON ${database}.${t} FOR SELECT
                USING workspace_id = toUUIDOrZero(getSettingOrDefault('SQL_workspace', '')) TO ALL`,
      });
    return true;
  } catch (err) {
    const why = `ClickHouse row policies could not be applied: ${(err as Error).message.split('\n')[0]}`;
    if (mode === 'required') throw new Error(`${why}. Grant the user access management, or set CLICKHOUSE_ROW_POLICIES=auto.`);
    log(`${why}; queries are still filtered by workspace in code`);
    return false;
  }
}

/** Only the server's own "unknown setting" answer may mean it does not take `SQL_` settings. */
function isUnknownSetting(err: unknown): boolean {
  const e = err as { type?: unknown; code?: unknown } | null;
  return e?.type === 'UNKNOWN_SETTING' || Number(e?.code) === 115;
}

/**
 * Whether the server takes `SQL_` custom settings. A restore's store tags the probe with its
 * `query_id` and passes its lock-loss signal, so a successor's drain sees it and a lost lock
 * cancels it instead of leaving an untagged request behind (#1204 review).
 *
 * `false` is reserved for the one answer that proves the server does not take the setting. A
 * transport error or timeout rejects: callers must not cache "not accepted" from a failed request
 * (#1225). Exported for the test that pins that distinction.
 */
export async function acceptsWorkspaceSetting(
  client: Pick<ClickHouseClient, 'command'>,
  opts: { signal?: AbortSignal; queryIdPrefix?: string } = {},
) {
  try {
    await client.command({
      query: 'SELECT 1',
      clickhouse_settings: { SQL_workspace: '' } as never,
      ...(opts.queryIdPrefix ? { query_id: `${opts.queryIdPrefix}${randomUUID()}` } : {}),
      ...(opts.signal ? { abort_signal: opts.signal } : {}),
    });
    return true;
  } catch (err) {
    if (isUnknownSetting(err)) return false;
    throw err;
  }
}

/**
 * The settings one workspace read carries for a probe answer. In `required` mode a server that does
 * not take `SQL_workspace` is an error, not an empty set: with the row policies applied the policy
 * would hide every row and the read would look like an empty workspace (#1225).
 */
export function workspaceSettings(
  workspaceId: string,
  accepts: boolean,
  mode: 'required' | 'auto' | 'off' | undefined,
): Record<string, string> {
  if (accepts) return { SQL_workspace: workspaceId };
  if (mode === 'required')
    throw new Error(
      'ClickHouse no longer accepts the SQL_workspace setting, so row policies would hide every row; refusing to read without it. ' +
        'Restore the SQL_ custom-settings prefix on the server, or set CLICKHOUSE_ROW_POLICIES=auto.',
    );
  return {};
}

export interface MessageEvent {
  workspaceId: string;
  messageId: string;
  /** Unique per event of a message (provider event id, or the decision). */
  eventId: string;
  type:
    | 'queued'
    | 'sent'
    | 'suppressed'
    | 'failed'
    | 'delivered'
    | 'bounced'
    | 'deferred'
    | 'complained'
    | 'opened'
    | 'clicked'
    | 'unsubscribed';
  at: string;
  profileId: string;
  channel: string;
  purpose: string;
  provider: string;
  templateId: string;
  templateVersion: number;
  journeyId: string;
  /** Subject-test variant on the message (A, B, …); empty outside a test. */
  variant?: string;
  reason: string;
  url: string;
}

/**
 * How a message-event batch is published as customer events. The outbox passes the time the batch
 * was queued, so a row delivered (or requeued) days later still produces carrier events with the
 * age of their original delivery (#1027) instead of looking like a fresh one.
 */
export interface MessageEventPublishOptions {
  /** When the message events reached the platform; defaults to now. */
  receivedAt?: Date;
}

/** Which message events to count, and how to narrow them (a segment's message condition, #441). */
export interface MessageEventCountQuery {
  type: MessageEvent['type'];
  sinceSeconds?: number;
  channel?: string;
  purpose?: string;
  /**
   * The broadcast or journey that sent the messages. Both are stored in the same `journey_id`
   * column, distinguished by their id prefix, as the analytics layer reads them.
   */
  sentBy?: string;
  /** Restrict to these profiles (a streaming or on-demand check for a few people). */
  profileIds?: string[];
}

export interface JourneyEvent {
  workspaceId: string;
  journeyId: string;
  version: number;
  participantId: number;
  profileId: string;
  node: string;
  type: 'entered' | 'step' | 'waiting' | 'resumed' | 'converted' | 'completed' | 'exited' | 'failed' | 'holdout_assigned';
  seq: number;
  at: string;
  detail: string;
}

export interface StoredEvent {
  eventId: string;
  sourceId: string;
  type: string;
  name: string;
  timestamp: string;
  receivedAt: string;
  anonymousId: string;
  userId: string;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
}

/** Every subject column starts empty; the hashes fill the ones the row applies to. */
function subjectColumns(hashes: SubjectKeyHashes | null, coverage: SubjectCoverage): Record<string, string> {
  const out: Record<string, string> = { subject_key_version: hashes?.version ?? '', subject_coverage: coverage };
  for (const column of Object.values(SUBJECT_KEY_COLUMNS)) out[column] = '';
  if (hashes) for (const [kind, value] of Object.entries(hashes.hashes)) out[SUBJECT_KEY_COLUMNS[kind as SubjectKeyKind]] = value as string;
  return out;
}

const toRow = (e: BusEvent, subject: SubjectKeyHashes | null) => ({
  workspace_id: e.workspaceId,
  event_id: e.messageId,
  source_id: e.sourceId,
  received_at: e.receivedAt.replace('Z', ''),
  timestamp: e.timestamp.replace('Z', ''),
  type: e.type,
  name: e.name,
  anonymous_id: e.anonymousId,
  user_id: e.userId,
  profile_id: e.profileId ?? '',
  properties: e.properties,
  traits: e.traits,
  context: e.context,
  consent: e.consent,
  // The durable subject keys (#1037 part 1): HMAC_exclusion of every id and click id this event
  // names, and of its e-mail/phone traits while they are still in memory. `subject_coverage` says
  // whether the writer saw everything (`full`) or wrote nothing (`none`), so a reader never treats
  // a partial row as complete.
  ...subjectColumns(subject, subject ? 'full' : 'none'),
});

/** The subject values an event names, in the order they are hashed. */
function eventSubjectSources(e: BusEvent): [SubjectKeyKind, string][] {
  const out: [SubjectKeyKind, string][] = [];
  if (e.profileId) out.push(['profile', e.profileId]);
  if (e.anonymousId) out.push(['anonymous_id', e.anonymousId]);
  if (e.userId) out.push(['user_id', e.userId]);
  if (e.previousId) out.push(['alias_previous_id', e.previousId]);
  const email = e.piiTraits.email;
  if (typeof email === 'string' && email.trim()) out.push(['email', email]);
  const phone = e.piiTraits.phone;
  if (typeof phone === 'string' && phone.trim()) out.push(['phone', phone]);
  // The click-id hook turns these same context ids into identifiers of the person.
  out.push(...eventClickIds(e.context, e.timestamp));
  return out;
}

function profileSubjectSources(e: { profileId: string }): [SubjectKeyKind, string][] {
  return e.profileId ? [['profile', e.profileId]] : [];
}

/**
 * Hashes each row's subject values with its workspace's exclusion key. A failure is thrown, never
 * turned into an empty hash: the caller must retry rather than mark the row complete.
 */
async function subjectHashesFor<T extends { workspaceId: string }>(
  rows: readonly T[],
  factory: SubjectKeyHasherFactory | undefined,
  sources: (row: T) => [SubjectKeyKind, string][],
): Promise<(SubjectKeyHashes | null)[]> {
  const out: (SubjectKeyHashes | null)[] = rows.map(() => null);
  if (!factory || !rows.length) return out;
  const byWorkspace = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    const indexes = byWorkspace.get(row.workspaceId) ?? [];
    indexes.push(index);
    byWorkspace.set(row.workspaceId, indexes);
  }
  for (const [workspaceId, indexes] of byWorkspace) {
    const hasher = await factory(workspaceId);
    try {
      const cache = new Map<string, Promise<string>>();
      const hashOf = (kind: SubjectKeyKind, value: string) => {
        const key = `${kind}\u0000${value}`;
        let pending = cache.get(key);
        if (!pending) {
          pending = hasher.hash(kind, value);
          cache.set(key, pending);
        }
        return pending;
      };
      for (const index of indexes) {
        const hashes: Partial<Record<SubjectKeyKind, string>> = {};
        for (const [kind, value] of sources(rows[index] as T)) hashes[kind] = await hashOf(kind, value);
        out[index] = { version: hasher.version, hashes };
      }
    } finally {
      hasher.dispose();
    }
  }
  return out;
}

/** Applies the SQL files in packages/events/clickhouse once each, in order. */
export async function migrateClickHouse(
  url: string,
  database: string,
  log: (m: string) => void = () => {},
  opts: { rowPolicies?: 'required' | 'auto' | 'off' } = {},
) {
  const root = createClient(clientOptions(url));
  await root.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  await root.close();
  const ch = createClient({ ...clientOptions(url), database });
  await ch.command({
    query:
      'CREATE TABLE IF NOT EXISTS schema_migrations (name String, checksum String, at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY name',
  });
  const applied = new Map(
    (
      await (
        await ch.query({ query: 'SELECT name, checksum FROM schema_migrations', format: 'JSONEachRow' })
      ).json<{ name: string; checksum: string }>()
    ).map((r) => [r.name, r.checksum]),
  );
  for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum)
        throw new Error(`ClickHouse migration ${file} was changed after it was applied. Add a new file instead.`);
      continue;
    }
    for (const statement of sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean))
      await ch.command({ query: statement });
    await ch.insert({ table: 'schema_migrations', values: [{ name: file, checksum }], format: 'JSONEachRow' });
    log(`applied ClickHouse migration ${file}`);
  }
  await applyRowPolicies(ch, database, opts.rowPolicies ?? 'auto', log);
  await ch.close();
}

/**
 * The subject-key join and their effective profile key for a message-event read (#1037 part 2).
 * Message events carry only a profile id; the backfill can only supply that one kind, so a
 * non-`full` historical row coalesces just this column.
 */
const messageSideJoin = (row: string, side = 's') => `LEFT JOIN (
    SELECT workspace_id AS side_workspace_id, key1 AS side_key1, key2 AS side_key2, key3 AS side_key3,
           subject_profile AS side_profile, 1 AS side_found
     FROM subject_key_backfill FINAL
     WHERE workspace_id = {ws:UUID} AND table_name = 'message_events'
  ) AS ${side}
    ON ${side}.side_workspace_id = ${row}.workspace_id
   AND ${side}.side_key1 = ${row}.message_id AND ${side}.side_key2 = ${row}.type AND ${side}.side_key3 = ${row}.event_id`;
const messageEffectiveProfile = (row: string, side = 's') =>
  `if(${row}.subject_coverage = 'full', ${row}.subject_profile, coalesce(nullIf(${row}.subject_profile, ''), ${side}.side_profile))`;

/**
 * The most subject keys an id-scoped message-event read will carry into its bounded exclusion set.
 * Past this, the read uses the protected view instead: building a ledger-sized set is cheaper than
 * a set this wide, and the read already names its own messages, so only their people's keys can
 * match.
 */
export const MESSAGE_SCOPE_KEY_LIMIT = 20_000;

/** The `WHERE` of a message-event count, shared by the protected, the id-scoped and the scope reads. */
function messageCountConditions(q: MessageEventCountQuery, row = 'm'): { conditions: string[]; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { msgType: q.type };
  const conditions = [`${row}.workspace_id = {ws:UUID}`, `${row}.type = {msgType:String}`, `${row}.profile_id != ''`];
  if (q.sinceSeconds !== undefined) {
    params.since = q.sinceSeconds;
    conditions.push(`${row}.at >= now64(3) - toIntervalSecond({since:UInt32})`);
  }
  if (q.channel !== undefined) {
    params.channel = q.channel;
    conditions.push(`${row}.channel = {channel:String}`);
  }
  if (q.purpose !== undefined) {
    params.purpose = q.purpose;
    conditions.push(`${row}.purpose = {purpose:String}`);
  }
  if (q.sentBy !== undefined) {
    params.sentBy = q.sentBy;
    conditions.push(`${row}.journey_id = {sentBy:String}`);
  }
  if (q.profileIds) {
    params.profiles = q.profileIds;
    conditions.push(`${row}.profile_id IN {profiles:Array(String)}`);
  }
  return { conditions, params };
}

/** The `WHERE` of a message-stat read, per row alias (the scoped bound re-reads the same rows). */
function messageStatsConditions(
  q: { since: Date; until?: Date; templateId?: string; journeyId?: string; messageIds?: string[]; variant?: string },
  row = 'm',
): { conditions: string[]; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    since: q.since.toISOString().replace('Z', ''),
    ...(q.until ? { until: q.until.toISOString().replace('Z', '') } : {}),
    t: q.templateId ?? '',
    j: q.journeyId ?? '',
    v: q.variant ?? '',
    ids: q.messageIds ?? [],
  };
  const conditions = [
    `${row}.workspace_id = {ws:UUID}`,
    `${row}.at >= {since:DateTime64(3, 'UTC')}`,
    ...(q.until ? [`${row}.at < {until:DateTime64(3, 'UTC')}`] : []),
    ...(q.templateId ? [`${row}.template_id = {t:String}`] : []),
    ...(q.journeyId ? [`${row}.journey_id = {j:String}`] : []),
    ...(q.variant ? [`${row}.variant = {v:String}`] : []),
    ...(q.messageIds ? [`${row}.message_id IN {ids:Array(String)}`] : []),
  ];
  return { conditions, params };
}

/**
 * The scoped source reads `message_events` twice in one statement (the key bound and the rows).
 * Pin one storage snapshot for the whole query so both see the same parts even where a settings
 * profile turned the default off; otherwise the #1195 race returns (#1200 review).
 */
export const SCOPED_SNAPSHOT_SETTINGS = { enable_shared_storage_snapshot_in_query: 1 } as const;

/**
 * The id-scoped message-event source (#1037 part 2): the protected views' predicate with the
 * workspace's exclusion set bounded to the subject keys this scope's own rows carry, so a broadcast
 * guardrail does not build the whole ledger. The bound is derived inside the same statement as the
 * read (#1195): reading it in an earlier query let a fully keyed row committed between the two be
 * counted for an erased profile. `side_found` mirrors the protected view: a row that is neither
 * complete nor backfilled is unverified, so it is not returned.
 */
function messageScopedSource(where: string, scopeWhere: string): string {
  const scopeKeys = `SELECT DISTINCT arrayJoin([sm.subject_profile, ss.side_profile]) AS k
      FROM message_events AS sm FINAL ${messageSideJoin('sm', 'ss')}
     WHERE ${scopeWhere} AND k != ''`;
  return `(SELECT m.* FROM message_events AS m FINAL ${messageSideJoin('m')}
      WHERE ${where}
        AND (m.subject_coverage = 'full' OR s.side_found = 1
             OR NOT EXISTS (SELECT 1 FROM erased_subjects WHERE workspace_id = {ws:UUID} LIMIT 1))
        AND ${messageEffectiveProfile('m')} NOT IN (
          SELECT key FROM erased_subjects FINAL
           WHERE workspace_id = {ws:UUID} AND key IN (${scopeKeys})
        ))`;
}

/**
 * The SQL a message-event count runs (#441): `message_events FINAL` over the workspace's own parts
 * (the primary key starts with `workspace_id`), aggregated in ClickHouse so only one row per person
 * crosses the wire. The count is distinct `message_id`s, not events: a mailbox that prefetches an
 * open pixel twice, or a person who clicks one link twice, engaged with one message (#1072).
 * Exported so the plan guard in the tests follows the real query rather than a copy.
 *
 * `scoped` switches to the id-scoped shape (#1037 part 2): the ledger set is bounded to the keys
 * the rows this scope names carry, and that bound is derived inside this statement (#1195). It is
 * only a width decision made by the caller; an empty result still runs the predicate. Otherwise the
 * protected view is read.
 */
export function messageEventCountQuery(workspaceId: string, q: MessageEventCountQuery, protectedRead = true, scoped = false) {
  const { conditions, params } = messageCountConditions(q);
  params.ws = workspaceId;
  const where = conditions.join(' AND ');
  if (scoped) {
    return {
      query: `SELECT m.profile_id, uniqExact(m.message_id) AS c FROM ${messageScopedSource(
        where,
        messageCountConditions(q, 'sm').conditions.join(' AND '),
      )} AS m GROUP BY m.profile_id`,
      query_params: params,
      format: 'JSONEachRow' as const,
      clickhouse_settings: SCOPED_SNAPSHOT_SETTINGS,
    };
  }
  return {
    query: `SELECT m.profile_id, uniqExact(m.message_id) AS c FROM ${personReadSource('message_events', protectedRead)} AS m FINAL
            WHERE ${where}
            GROUP BY m.profile_id`,
    query_params: params,
    format: 'JSONEachRow' as const,
  };
}

/** A table's backfill cursor for one workspace. It is reset when a pass completes. */
interface BackfillCursor {
  cursor: string;
  revision: number;
}

const EMPTY_CURSOR: BackfillCursor = { cursor: '', revision: 0 };

async function readBackfillCursor(client: ClickHouseClient, table: string, workspaceId: string): Promise<BackfillCursor> {
  const rs = await client.query({
    query: `SELECT cursor, revision FROM subject_key_backfill_cursors FINAL
            WHERE table_name = {table:String} AND workspace_id = {ws:UUID} LIMIT 1`,
    query_params: { table, ws: workspaceId },
    format: 'JSONEachRow',
  });
  const [row] = await rs.json<{ cursor: string; revision: number | string }>();
  if (!row) return EMPTY_CURSOR;
  return { cursor: row.cursor ?? '', revision: Number(row.revision ?? 0) };
}

async function writeBackfillCursor(client: ClickHouseClient, table: string, workspaceId: string, next: BackfillCursor): Promise<void> {
  await client.insert({
    table: 'subject_key_backfill_cursors',
    values: [{ table_name: table, workspace_id: workspaceId, cursor: next.cursor, revision: next.revision }],
    format: 'JSONEachRow',
  });
}

/**
 * The keyset predicate after the last processed primary-key tuple, typed per sort column.
 *
 * ClickHouse's primary-key analysis does not use a tuple comparison (`(a, b, c) > (A, B, C)`) to
 * choose granules, so that form reads the workspace's whole range for every batch. The expanded
 * column comparisons it does analyse — `a > A OR (a = A AND (b > B OR …))` — select the same rows
 * but let the server start at the cursor's granule (#1226).
 */
export function cursorPredicate(
  spec: (typeof SUBJECT_KEY_BACKFILL_TABLES)[number],
  cursor: string,
): { sql: string; params: Record<string, unknown> } {
  if (!cursor) return { sql: '', params: {} };
  const values = JSON.parse(cursor) as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  const typed = spec.sortColumns.map((column, index) => {
    params[`c${index}`] = values[column.name];
    return { name: `t.${column.name}`, value: `{c${index}:${column.type}}` };
  });
  const expand = (index: number): string => {
    const { name, value } = typed[index]!;
    const after = `${name} > ${value}`;
    if (index === typed.length - 1) return after;
    return `(${after} OR (${name} = ${value} AND ${expand(index + 1)}))`;
  };
  return { sql: `AND ${expand(0)}`, params };
}

/**
 * One batch select of the subject-key backfill: the next `limit` uncovered rows after the cursor,
 * in the table's sort order. Exported so a test can pin the predicate the server actually analyses
 * rather than a copy, and so a plan guard can run `EXPLAIN indexes = 1` on it.
 */
export function subjectKeyBackfillBatchQuery(
  spec: (typeof SUBJECT_KEY_BACKFILL_TABLES)[number],
  o: { workspaceId: string; cursor?: string; limit?: number },
) {
  const after = cursorPredicate(spec, o.cursor ?? '');
  return {
    // FINAL sees one logical row per replacing key, so a complete concurrent redelivery hides an
    // older incomplete copy. The side join skips identities already backfilled.
    query: `SELECT t.* FROM ${spec.table} AS t FINAL
            LEFT JOIN subject_key_backfill AS s FINAL
              ON s.workspace_id = t.workspace_id AND s.table_name = {table:String} AND ${identityJoin(spec)}
            WHERE t.workspace_id = {ws:UUID} AND t.subject_coverage != 'full' AND s.table_name = '' ${after.sql}
            ORDER BY ${spec.sortColumns.map((column) => `t.${column.name}`).join(', ')}
            LIMIT {limit:UInt32}`,
    query_params: { table: spec.table, ws: o.workspaceId, ...after.params, limit: o.limit ?? 5_000 },
  };
}

/** The join from a person table to its side-table identity, and the values to store there. */
function identityJoin(spec: (typeof SUBJECT_KEY_BACKFILL_TABLES)[number]): string {
  return spec.identity.map((identity) => `s.${identity.key} = toString(t.${identity.column})`).join(' AND ');
}

function identityValues(spec: (typeof SUBJECT_KEY_BACKFILL_TABLES)[number], row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { key1: '', key2: '', key3: '', key4: '' };
  for (const identity of spec.identity) out[identity.key] = String(row[identity.column] ?? '');
  return out;
}

/**
 * The effective subject keys of one row, exactly as the protected views compute them: its own
 * columns when coverage is `full`, otherwise coalesced with the identity-keyed side entry. Used by
 * the physical purge so it deletes precisely the rows a protected read would hide (#1037 part 3).
 */
function effectiveSubjectKeys(row = 't', side = 's'): string {
  return SUBJECT_KEY_KINDS.map((kind) => {
    const column = SUBJECT_KEY_COLUMNS[kind];
    return `if(${row}.subject_coverage = 'full', ${row}.${column}, coalesce(nullIf(${row}.${column}, ''), ${side}.side_${column}))`;
  }).join(', ');
}

/** The purge's side-table join: the same identity key and substitution the protected views use. */
function purgeSideJoin(spec: (typeof SUBJECT_KEY_BACKFILL_TABLES)[number]): string {
  const columns = SUBJECT_KEY_KINDS.map(
    (kind) => `subject_${SUBJECT_KEY_COLUMNS[kind].replace('subject_', '')} AS side_${SUBJECT_KEY_COLUMNS[kind]}`,
  );
  return `LEFT JOIN (
    SELECT workspace_id AS side_workspace_id, ${spec.identity.map((identity) => `${identity.key} AS side_${identity.key}`).join(', ')},
           ${columns.join(', ')}
      FROM subject_key_backfill FINAL
     WHERE workspace_id = {ws:UUID} AND table_name = {table:String}
  ) AS s
    ON s.side_workspace_id = t.workspace_id AND ${spec.identity
      .map((identity) => `s.side_${identity.key} = toString(t.${identity.column})`)
      .join(' AND ')}`;
}

/** The purge's exclusion predicate: any effective subject key is a retained exclusion key. */
function purgeMatch(): string {
  return `arrayExists(k -> k != '' AND k IN {keys:Array(String)}, [${effectiveSubjectKeys()}])`;
}

/**
 * How one identity is selected, bound as a query parameter, compared and read back. Every statement
 * that names a row — the batch select, the base-row guard, the delete and the survivor count — uses
 * the same shape, so a three-column identity (`message_events`) can never be read back as a short
 * tuple and then bound as a four-string one, which ClickHouse rejects with
 * CANNOT_PARSE_INPUT_ASSERTION_FAILED (#1198 review).
 */
interface IdentityShape {
  /** The identity's columns, in order. */
  readonly columns: readonly string[];
  /** The `Array(Tuple(...))` type of a bound list of identities. */
  readonly type: string;
  /** The aliased SELECT list that reads one identity out of a query. */
  select(alias: string): string;
  /** The identity's tuple expression, for a table alias (or none) and a leading column count. */
  tuple(alias: string, width?: number): string;
  /** JSONEachRow rows -> identities, in `columns` order. */
  read(rows: Record<string, string>[]): string[][];
}

function identityShape(columns: readonly string[]): IdentityShape {
  const ref = (alias: string, column: string) => (alias ? `${alias}.${column}` : column);
  return {
    columns,
    type: `Array(Tuple(${columns.map(() => 'String').join(', ')}))`,
    select: (alias) => columns.map((column, index) => `toString(${ref(alias, column)}) AS id${index}`).join(', '),
    // `toString` gives one parameter shape for String, DateTime64 and integer identity columns, and
    // matches what the select reads back.
    tuple: (alias, width = columns.length) =>
      `(${columns
        .slice(0, width)
        .map((column) => `toString(${ref(alias, column)})`)
        .join(', ')})`,
    read: (rows) => rows.map((row) => columns.map((_, index) => String(row[`id${index}`] ?? ''))),
  };
}

/** A person table's own identity, from the same spec that names its side-table keys. */
const baseShape = (spec: (typeof SUBJECT_KEY_BACKFILL_TABLES)[number]) => identityShape(spec.identity.map((identity) => identity.column));

/** The side table always keeps four keys, whatever the base table's identity width. */
const sideShape = identityShape(['key1', 'key2', 'key3', 'key4']);

/**
 * How many bytes of a rendered tuple parameter one delete may carry. A query parameter travels as a
 * single HTTP form field, and ClickHouse refuses one over `http_max_field_value_size` (128 KiB by
 * default) with "Field value too long" on every retry: a 1,000-event purge already fails. 32 KiB
 * leaves room for the query, the settings and their URI escaping while still deleting hundreds of
 * rows per mutation.
 */
const PURGE_PARAM_BUDGET = 32 * 1024;

/** Bytes one value costs inside a query parameter: quoted, with the client's escaping. */
function quotedBytes(value: string): number {
  // The parameter travels URL-encoded: measure what the server's field limit sees, not UTF-16
  // code units. A CJK character is three UTF-8 bytes and nine bytes percent-encoded (#1199 review).
  let escaped = "'";
  for (const ch of value)
    escaped += ch === '\t' ? '\\t' : ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === "'" || ch === '\\' ? `\\${ch}` : ch;
  return encodeURIComponent(`${escaped}'`).length;
}

/**
 * One batch's identities split so each `{ids}` parameter stays under the HTTP field limit. The last
 * chunk is never empty, so a single identity that is over budget on its own still travels alone
 * rather than being dropped.
 */
function identityChunks(ids: string[][]): string[][][] {
  const chunks: string[][][] = [];
  let chunk: string[][] = [];
  // `[` and `]` around the array, and one comma between tuples; each is three bytes URL-encoded.
  const SEP = encodeURIComponent(',').length;
  const OPEN_CLOSE = encodeURIComponent('[]').length;
  let bytes = OPEN_CLOSE;
  for (const id of ids) {
    const rendered =
      encodeURIComponent('()').length + id.reduce((total, value) => total + quotedBytes(value), Math.max(0, id.length - 1) * SEP);
    if (chunk.length && bytes + SEP + rendered > PURGE_PARAM_BUDGET) {
      chunks.push(chunk);
      chunk = [];
      bytes = OPEN_CLOSE;
    }
    bytes += (chunk.length ? SEP : 0) + rendered;
    chunk.push(id);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/**
 * Logical rows that still lack coverage: their own writer did not fill the subject columns and the
 * side table has no result for their identity. FINAL is deliberate — it sees one logical row per
 * replacing key, so a complete concurrent redelivery is never counted as missing.
 */
async function uncoveredRows(
  client: ClickHouseClient,
  spec: (typeof SUBJECT_KEY_BACKFILL_TABLES)[number],
  workspaceId: string,
  settings: Record<string, string>,
): Promise<number> {
  const rs = await client.query({
    query: `SELECT count() AS n FROM ${spec.table} AS t FINAL
            LEFT JOIN subject_key_backfill AS s FINAL
              ON s.workspace_id = t.workspace_id AND s.table_name = {table:String} AND ${identityJoin(spec)}
            WHERE t.workspace_id = {ws:UUID} AND t.subject_coverage != 'full' AND s.table_name = ''`,
    query_params: { table: spec.table, ws: workspaceId },
    format: 'JSONEachRow',
    clickhouse_settings: settings,
  });
  const [row] = await rs.json<{ n: number | string }>();
  return Number(row?.n ?? 0);
}

export function clickHouseStore(opts: {
  url: string;
  database: string;
  subjectKeys?: SubjectKeyHasherFactory;
  /**
   * The workspace durable-ledger check the fast path uses. Without one every read is protected:
   * fail closed rather than guess that a workspace has nothing to exclude.
   */
  hasErasures?: (workspaceId: string) => Promise<boolean>;
  /**
   * Aborted when every request this store issues must stop (#1204 review). The restore passes its
   * lock-loss signal so an in-flight exclusion publication is cancelled rather than landing after
   * another restore may own the database.
   */
  signal?: AbortSignal;
  /**
   * Prefix for each request's `query_id` (#1204 review). A restore sets it so a successor finds an
   * in-flight exclusion publication in ClickHouse's `system.processes` before it writes.
   */
  queryIdPrefix?: string;
  /**
   * The server's row-policy mode. With `required`, a workspace read refuses to run when the server
   * answers that it no longer takes `SQL_workspace`: without the setting the policy hides every
   * row, so a silent empty read would look like an empty workspace (#1225).
   */
  rowPolicies?: 'required' | 'auto' | 'off';
}): EventStore {
  const client = createClient({
    ...clientOptions(opts.url),
    database: opts.database,
    // Every request is client-bounded. The erasure cleanup schedules its second sweep from this
    // interval; it does not claim that a timed-out server-side write has ended (#1037).
    request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS,
    // Large identity scopes exceed the server URI limit when encoded as URL parameters.
    use_multipart_params_auto: true,
    clickhouse_settings: { date_time_input_format: 'best_effort', output_format_json_quote_64bit_integers: 0 },
  });
  const idFilter = 'workspace_id = {ws:UUID} AND (anonymous_id IN {anon:Array(String)} OR user_id IN {users:Array(String)})';
  const params = (workspaceId: string, ids: { anonymousIds: string[]; userIds: string[] }) => ({
    ws: workspaceId,
    anon: ids.anonymousIds,
    users: ids.userIds,
  });
  // Whether the server takes the SQL_workspace setting; when it does, every query names its workspace.
  // Only a real answer is cached. A transport failure rejects this call and clears the cache, so the
  // next request probes again instead of running without the setting for the process's life (#1225).
  let accepts: Promise<boolean> | undefined;
  const settingsFor = async (workspaceId: string): Promise<Record<string, string>> => {
    accepts ??= acceptsWorkspaceSetting(client, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.queryIdPrefix ? { queryIdPrefix: opts.queryIdPrefix } : {}),
    }).catch((err: unknown) => {
      accepts = undefined;
      throw err;
    });
    return workspaceSettings(workspaceId, await accepts, opts.rowPolicies);
  };
  type QueryArgs = Parameters<ClickHouseClient['query']>[0];
  const abort = () => (opts.signal ? { abort_signal: opts.signal } : {});
  const queryId = () => (opts.queryIdPrefix ? { query_id: `${opts.queryIdPrefix}${randomUUID()}` } : {});
  const query = async (workspaceId: string, args: QueryArgs & { format: 'JSONEachRow' }) =>
    client.query({
      ...args,
      ...abort(),
      ...queryId(),
      clickhouse_settings: { ...args.clickhouse_settings, ...((await settingsFor(workspaceId)) as object) },
    });
  const command = async (workspaceId: string, args: Parameters<ClickHouseClient['command']>[0]) =>
    client.command({
      ...args,
      ...abort(),
      ...queryId(),
      clickhouse_settings: { ...args.clickhouse_settings, ...((await settingsFor(workspaceId)) as object) },
    });
  const countQuery = (
    workspaceId: string,
    q: {
      name: string;
      where?: Record<string, string | number | boolean>;
      sinceSeconds?: number;
      ids?: { anonymousIds: string[]; userIds: string[] };
      excludeEventIds?: string[];
    },
    protectedRead: boolean,
  ) => {
    const params: Record<string, unknown> = { ws: workspaceId, name: q.name, exclude: q.excludeEventIds ?? [] };
    const where = Object.entries(q.where ?? {}).map(([k, v], i) => {
      // Keys are validated as [A-Za-z0-9_]; values travel as parameters.
      if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) throw new Error(`invalid property name ${k}`);
      params[`v${i}`] = String(v);
      return `toString(properties.\`${k}\`) = {v${i}:String}`;
    });
    if (q.sinceSeconds) params.since = q.sinceSeconds;
    if (q.ids) Object.assign(params, { anon: q.ids.anonymousIds, users: q.ids.userIds });
    return {
      query: `SELECT anonymous_id, user_id, count() AS c FROM ${personReadSource('events', protectedRead)} FINAL
              WHERE workspace_id = {ws:UUID} AND name = {name:String}
              ${q.sinceSeconds ? 'AND timestamp >= now64(3) - toIntervalSecond({since:UInt32})' : ''}
              ${q.ids ? 'AND (anonymous_id IN {anon:Array(String)} OR user_id IN {users:Array(String)})' : ''}
              ${q.excludeEventIds?.length ? 'AND event_id NOT IN {exclude:Array(String)}' : ''}
              ${where.map((w) => `AND ${w}`).join(' ')}
              GROUP BY anonymous_id, user_id`,
      query_params: params,
      format: 'JSONEachRow' as const,
    };
  };
  const countRow = (r: { anonymous_id: string; user_id: string; c: number }) => ({
    anonymousId: r.anonymous_id,
    userId: r.user_id,
    count: Number(r.c),
  });
  const messageCountRow = (r: { profile_id: string; c: number | string }) => ({ profileId: r.profile_id, count: Number(r.c) });
  /** This request's protected-read decision; `false` only for a workspace with no ledger row. */
  const protectedReadFor = async (workspaceId: string): Promise<boolean> => (opts.hasErasures ? opts.hasErasures(workspaceId) : true);
  /** The workspace's published exclusion hashes. FINAL so a republished exclusion counts once. */
  const readErasedSubjectKeys = async (workspaceId: string): Promise<Set<string>> => {
    const rs = await query(workspaceId, {
      query: `SELECT key FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}`,
      query_params: { ws: workspaceId },
      format: 'JSONEachRow',
    });
    return new Set((await rs.json<{ key: string }>()).map((row) => row.key));
  };
  /**
   * Whether an id-scoped message-event count may bound its exclusion set: false for a base read or
   * a scope wider than the bound, which then uses the protected view. The probe is only a width
   * decision — the keys are not the exclusion set — so a row committed after it still meets the
   * predicate the counting statement derives itself (#1195).
   */
  const messageScopeFits = async (
    workspaceId: string,
    protectedRead: boolean,
    conditions: string[],
    params: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!protectedRead) return false;
    const rs = await query(workspaceId, {
      query: `SELECT DISTINCT arrayJoin([m.subject_profile, s.side_profile]) AS k
              FROM message_events AS m FINAL ${messageSideJoin('m')}
              WHERE ${conditions.join(' AND ')} AND k != ''
              LIMIT {scope_limit:UInt32}`,
      query_params: { ws: workspaceId, ...params, scope_limit: MESSAGE_SCOPE_KEY_LIMIT + 1 },
      format: 'JSONEachRow',
    });
    const keys = await rs.json<{ k: string }>();
    // Wider than the bound: the view is the cheaper source for a ledger-sized set.
    return keys.length <= MESSAGE_SCOPE_KEY_LIMIT;
  };
  /**
   * Pending message events a metric snapshot may count: the ones whose profile is not an erased
   * subject. The published half of a union is filtered by the protected view; this is the half that
   * has not reached ClickHouse yet.
   */
  const withoutErased = async (workspaceId: string, events: readonly MessageEvent[]): Promise<MessageEvent[]> => {
    if (!events.length) return [];
    const erased = await readErasedSubjectKeys(workspaceId);
    if (!erased.size) return [...events];
    if (!opts.subjectKeys)
      throw new Error(
        'the event store has no exclusion-key hasher, so pending message events cannot be checked against the erasure ledger',
      );
    const hasher = await opts.subjectKeys(workspaceId);
    try {
      const kept: MessageEvent[] = [];
      for (const event of events) {
        if (!event.profileId) {
          kept.push(event);
          continue;
        }
        if (!erased.has(await hasher.hash('profile', event.profileId))) kept.push(event);
      }
      return kept;
    } finally {
      hasher.dispose();
    }
  };
  return {
    client,
    settingsFor,
    hasErasures: protectedReadFor,
    async insert(events) {
      if (!events.length) return 0;
      // Hashes are computed before the insert, while the event's PII traits and click ids are
      // still in memory. A key failure throws, so the sink redelivers instead of storing a row
      // marked complete with missing keys. An event whose own fields cannot be read is dropped and
      // logged instead: re-delivering it cannot make it readable, and failing the whole batch would
      // hold back every other workspace's events until the stream's max age drops it. Only the
      // workspace, event id and a fixed reason are logged, never the payload or the exception. A
      // value the writer already defaults (an absent map, a `null` profile id) is recovered first.
      const readable: { event: BusEvent; workspaceId: string; sources: [SubjectKeyKind, string][] }[] = [];
      for (const event of events) {
        normalizeEvent(event);
        const field = unreadableEventReason(event);
        if (field) {
          logger.error({ ...eventCorrelation(event), field }, 'event dropped from the sink batch: its payload could not be read');
          continue;
        }
        // Nothing below this point throws for a readable record: a key or ClickHouse failure does,
        // and propagates so the batch is retried.
        readable.push({ event, workspaceId: event.workspaceId, sources: eventSubjectSources(event) });
      }
      let subject: (SubjectKeyHashes | null)[];
      try {
        subject = await subjectHashesFor(readable, opts.subjectKeys, (row) => row.sources);
      } catch (err) {
        noteSubjectKeyFailure();
        throw err;
      }
      const rows = readable.map((row, index) => toRow(row.event, subject[index] ?? null));
      if (!rows.length) return 0;
      await client.insert({
        table: 'events',
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: SYNC_INSERT,
      });
      return rows.length;
    },
    async eventsOf(workspaceId, ids, o = {}) {
      if (!ids.anonymousIds.length && !ids.userIds.length) return [];
      // Page on the full replacing key (timestamp, name, anonymous_id, event_id) descending, as
      // conversionEvents walks it ascending: two rows that tie on timestamp and event id but
      // differ by name or anonymous id both survive FINAL and must not be dropped at a boundary
      // (#840). A cursor written before #840 lacks the name and anonymous id; it falls back to the
      // old (timestamp, event_id) tuple, which always makes progress and may skip the rare rows
      // that tie on both exactly as before #840. A cursor without an event id keeps the
      // strictly-before timestamp comparison for the same reason.
      const after = !o.before
        ? ''
        : o.beforeName === undefined || o.beforeAnonymousId === undefined
          ? o.beforeId
            ? "AND (timestamp, event_id) < ({before:DateTime64(3, 'UTC')}, {beforeId:String})"
            : "AND timestamp < {before:DateTime64(3, 'UTC')}"
          : o.beforeId
            ? "AND (timestamp, name, anonymous_id, event_id) < ({before:DateTime64(3, 'UTC')}, {beforeName:String}, {beforeAnonymousId:String}, {beforeId:String})"
            : "AND (timestamp, name, anonymous_id) <= ({before:DateTime64(3, 'UTC')}, {beforeName:String}, {beforeAnonymousId:String})";
      const protectedRead = await protectedReadFor(workspaceId);
      const rs = await query(workspaceId, {
        query: `SELECT event_id, source_id, type, name, timestamp, received_at, anonymous_id, user_id, properties, context
                FROM ${personReadSource('events', protectedRead)} FINAL
                WHERE ${idFilter} ${after}
                ORDER BY timestamp DESC, name DESC, anonymous_id DESC, event_id DESC LIMIT {limit:UInt32}`,
        query_params: {
          ...params(workspaceId, ids),
          limit: o.limit ?? 100,
          ...(o.before ? { before: o.before.replace('Z', '') } : {}),
          ...(o.before && o.beforeId ? { beforeId: o.beforeId } : {}),
          ...(o.before && o.beforeName ? { beforeName: o.beforeName } : {}),
          ...(o.before && o.beforeAnonymousId !== undefined ? { beforeAnonymousId: o.beforeAnonymousId } : {}),
        },
        format: 'JSONEachRow',
      });
      const rows = await rs.json<Record<string, never>>();
      return rows.map((r) => ({
        eventId: r.event_id,
        sourceId: r.source_id,
        type: r.type,
        name: r.name,
        timestamp: `${String(r.timestamp).replace(' ', 'T')}Z`,
        receivedAt: `${String(r.received_at).replace(' ', 'T')}Z`,
        anonymousId: r.anonymous_id,
        userId: r.user_id,
        properties: r.properties,
        context: r.context,
      }));
    },
    async eventsOfAnonymousIds(workspaceId, anonymousIds, perId) {
      if (!anonymousIds.length) return [];
      const protectedRead = await protectedReadFor(workspaceId);
      const rs = await query(workspaceId, {
        query: `SELECT event_id, source_id, type, name, timestamp, received_at, anonymous_id, user_id, properties, context
                FROM ${personReadSource('events', protectedRead)} FINAL
                WHERE workspace_id = {ws:UUID} AND anonymous_id IN {anon:Array(String)}
                ORDER BY timestamp DESC, event_id DESC
                LIMIT {perId:UInt32} BY anonymous_id`,
        query_params: { ws: workspaceId, anon: anonymousIds, perId },
        format: 'JSONEachRow',
      });
      const rows = await rs.json<Record<string, never>>();
      return rows.map((r) => ({
        eventId: r.event_id,
        sourceId: r.source_id,
        type: r.type,
        name: r.name,
        timestamp: `${String(r.timestamp).replace(' ', 'T')}Z`,
        receivedAt: `${String(r.received_at).replace(' ', 'T')}Z`,
        anonymousId: r.anonymous_id,
        userId: r.user_id,
        properties: r.properties,
        context: r.context,
      }));
    },
    async deleteEventsOf(workspaceId, ids) {
      if (ids.profileIds?.length)
        for (const table of ['message_events', 'journey_events'])
          await command(workspaceId, {
            query: `DELETE FROM ${table} WHERE workspace_id = {ws:UUID} AND profile_id IN {profiles:Array(String)}`,
            query_params: { ws: workspaceId, profiles: ids.profileIds },
          });
      if (!ids.anonymousIds.length && !ids.userIds.length) return;
      // Lightweight delete: rows disappear from queries at once and from disk on the next merge.
      await command(workspaceId, { query: `DELETE FROM events WHERE ${idFilter}`, query_params: params(workspaceId, ids) });
    },
    async purgeErasedSubjects(workspaceId, keys, opts = {}) {
      const batchSize = Math.max(1, Math.trunc(opts.batchSize ?? 10_000));
      const maxBatches = Math.max(1, Math.trunc(opts.maxBatches ?? 4));
      // A caller that owns a claim renews and checks it between batches. Returning false stops the
      // sweep before the next mutation, so a replica whose lease was taken over cannot overlap the
      // new owner's deletes.
      const keepClaim = opts.checkpoint ?? (async () => true);
      const unique = [...new Set(keys.filter((key) => key.length > 0))];
      const tables: { table: string; deleted: number; remaining: boolean }[] = [];
      let deleted = 0;
      let complete = true;
      let stopped = false;
      for (const spec of SUBJECT_KEY_BACKFILL_TABLES) {
        let tableDeleted = 0;
        let remaining = false;
        // No keys means there is nothing to match; do not issue a query whose predicate cannot be true.
        if (unique.length) {
          const join = purgeSideJoin(spec);
          const match = purgeMatch();
          const queryParams = { ws: workspaceId, keys: unique, table: spec.table, batch: batchSize };
          // Identities travel as literal tuples (`IN {ids:Array(Tuple(...))}`) rather than a
          // self-referencing subquery: a mutation may evaluate a subquery again, and an unordered
          // LIMIT inside it can then choose different rows than the ones counted, so a delete could
          // remove nothing (ClickHouse 26.8). The batch is selected once, deterministically, and the
          // delete removes exactly that batch. Values go through `toString` so one parameter shape
          // covers String, DateTime64 and integer identity columns.
          // One identity shape per table, shared by the select, the guard, the delete and the
          // survivor count.
          const base = baseShape(spec);
          const tupleParams = (ids: string[][]) => ({ ws: workspaceId, ids: ids.map((id) => new TupleParam(id)) });
          // Scope the match to this workspace explicitly: with row policies off, the same identity
          // or subject key in another workspace must not inflate the count or consume the batch
          // limit (#1146).
          const countBase = async () => {
            const rs = await query(workspaceId, {
              query: `SELECT count() AS n FROM ${spec.table} AS t FINAL ${join} WHERE t.workspace_id = {ws:UUID} AND ${match}`,
              query_params: queryParams,
              format: 'JSONEachRow',
            });
            const [row] = await rs.json<{ n: number | string }>();
            return Number(row?.n ?? 0);
          };
          const selectBatch = async () => {
            const rs = await query(workspaceId, {
              query: `SELECT ${base.select('t')} FROM ${spec.table} AS t FINAL ${join}
                       WHERE t.workspace_id = {ws:UUID} AND ${match}
                       ORDER BY ${base.columns.map((_, index) => `id${index}`).join(', ')}
                       LIMIT {batch:UInt32}`,
              query_params: queryParams,
              format: 'JSONEachRow',
            });
            return base.read(await rs.json<Record<string, string>>());
          };
          const countSurvivors = async (ids: string[][]) => {
            if (!ids.length) return 0;
            const rs = await query(workspaceId, {
              query: `SELECT count() AS n FROM ${spec.table} AS t FINAL
                       WHERE t.workspace_id = {ws:UUID} AND ${base.tuple('t')} IN {ids:${base.type}}`,
              query_params: tupleParams(ids),
              format: 'JSONEachRow',
            });
            const [row] = await rs.json<{ n: number | string }>();
            return Number(row?.n ?? 0);
          };
          for (let batch = 0; batch < maxBatches; batch++) {
            const matching = await countBase();
            if (matching === 0) {
              remaining = false;
              break;
            }
            const ids = await selectBatch();
            if (!ids.length) {
              // The rows the count saw were swept by another pass. Leave the table open for a later
              // round rather than reporting progress it did not make.
              remaining = true;
              break;
            }
            // The batch is selected once, but its delete is split so no single request carries more
            // than the server accepts as one query parameter (see `identityChunks`). Each chunk is
            // one mutation, and the claim is checked before every one of them.
            for (const chunk of identityChunks(ids)) {
              if (!(await keepClaim())) {
                stopped = true;
                break;
              }
              await command(workspaceId, {
                query: `DELETE FROM ${spec.table}
                         WHERE workspace_id = {ws:UUID}
                           AND ${base.tuple('')} IN {ids:${base.type}}`,
                query_params: tupleParams(chunk),
                clickhouse_settings: { mutations_sync: '2' },
              });
              // `deleted` is measured against the fixed chunk, not against the difference between
              // two counts: a concurrent insert of another matching row would otherwise cancel out a
              // real deletion and report zero (#1198).
              tableDeleted += Math.max(0, chunk.length - (await countSurvivors(chunk)));
            }
            if (stopped) {
              remaining = true;
              break;
            }
            // `mutations_sync=2` makes this count observe the deletes; a write that landed in the
            // meantime keeps the table open.
            const after = await countBase();
            remaining = after > 0;
            if (!remaining) break;
          }

          // The backfill side table is keyed by the row's raw identity. Once the base rows are gone
          // it is the last raw trace of the person, so the same purge round deletes the matching
          // side entries. Only do this once the base table has no matching row left: deleting a
          // side entry while its base row still exists would make that row visible again.
          if (!remaining && !stopped) {
            const sideMatch = `arrayExists(k -> k != '' AND k IN {keys:Array(String)}, [${SUBJECT_KEY_KINDS.map(
              (kind) => SUBJECT_KEY_COLUMNS[kind],
            ).join(', ')}])`;
            const sideKey = sideShape.tuple('');
            const countSide = async () => {
              const rs = await query(workspaceId, {
                query: `SELECT count() AS n FROM subject_key_backfill FINAL
                         WHERE workspace_id = {ws:UUID} AND table_name = {table:String} AND ${sideMatch}`,
                query_params: queryParams,
                format: 'JSONEachRow',
              });
              const [row] = await rs.json<{ n: number | string }>();
              return Number(row?.n ?? 0);
            };
            const selectSide = async () => {
              const rs = await query(workspaceId, {
                query: `SELECT ${sideShape.select('')}
                          FROM subject_key_backfill FINAL
                         WHERE workspace_id = {ws:UUID} AND table_name = {table:String} AND ${sideMatch}
                         ORDER BY ${sideShape.columns.join(', ')}
                         LIMIT {batch:UInt32}`,
                query_params: queryParams,
                format: 'JSONEachRow',
              });
              return sideShape.read(await rs.json<Record<string, string>>());
            };
            // A side entry pins the subject keys of a base row that has not been rewritten since
            // the backfill. If a late legacy row arrives after the base count reached zero, that
            // entry is the only thing that excludes it, so it must stay until its base row is gone
            // (#1198). Only a row whose coverage is not `full` uses the entry: a full-coverage row
            // ignores its side entry, so that entry is stale and may be removed. The delete repeats
            // this check in the same statement, which closes the small window between the read and
            // the mutation. The guard compares the side entry's leading keys with the base identity,
            // which is narrower for message events.
            const sideGuardKeys = sideShape.tuple('', base.columns.length);
            /** The side identity projected onto the base table's (possibly narrower) identity. */
            const baseId = (id: string[]) => id.slice(0, base.columns.length);
            const existingBaseIds = async (ids: string[][]) => {
              if (!ids.length) return new Set<string>();
              const rs = await query(workspaceId, {
                query: `SELECT ${base.select('t')} FROM ${spec.table} AS t FINAL
                         WHERE t.workspace_id = {ws:UUID} AND t.subject_coverage != 'full'
                           AND ${base.tuple('t')} IN {ids:${base.type}}`,
                query_params: { ws: workspaceId, ids: ids.map((id) => new TupleParam(baseId(id))) },
                format: 'JSONEachRow',
              });
              const rows = base.read(await rs.json<Record<string, string>>());
              return new Set(rows.map((row) => JSON.stringify(row)));
            };
            const countSideSurvivors = async (ids: string[][]) => {
              if (!ids.length) return 0;
              const rs = await query(workspaceId, {
                query: `SELECT count() AS n FROM subject_key_backfill FINAL
                         WHERE workspace_id = {ws:UUID} AND table_name = {table:String} AND ${sideKey} IN {ids:${sideShape.type}}`,
                query_params: { ...tupleParams(ids), table: spec.table },
                format: 'JSONEachRow',
              });
              const [row] = await rs.json<{ n: number | string }>();
              return Number(row?.n ?? 0);
            };
            for (let batch = 0; batch < maxBatches; batch++) {
              const matching = await countSide();
              if (matching === 0) {
                remaining = false;
                break;
              }
              const candidates = await selectSide();
              if (!candidates.length) {
                remaining = true;
                break;
              }
              let blocked = false;
              for (const chunk of identityChunks(candidates)) {
                if (!(await keepClaim())) {
                  stopped = true;
                  break;
                }
                const stillBacked = await existingBaseIds(chunk);
                const deletable = chunk.filter((id) => !stillBacked.has(JSON.stringify(baseId(id))));
                if (!deletable.length) {
                  // Every side entry in this chunk still backs a base row, including one that
                  // arrived after the base sweep: leave them and let the next round remove the row
                  // first.
                  blocked = true;
                  continue;
                }
                await command(workspaceId, {
                  query: `DELETE FROM subject_key_backfill
                           WHERE workspace_id = {ws:UUID} AND table_name = {table:String}
                             AND ${sideKey} IN {ids:${sideShape.type}}
                             AND ${sideGuardKeys} NOT IN (
                               SELECT ${base.tuple('t')} FROM ${spec.table} AS t FINAL
                                WHERE t.workspace_id = {ws:UUID} AND t.subject_coverage != 'full'
                                  AND ${base.tuple('t')} IN {guards:${base.type}}
                             )`,
                  // `guards` is the same identity projected onto the base table's columns, which are
                  // narrower than the side table's four keys for message events; one parameter
                  // cannot carry both shapes.
                  query_params: {
                    ws: workspaceId,
                    table: spec.table,
                    ids: deletable.map((id) => new TupleParam(id)),
                    guards: deletable.map((id) => new TupleParam(baseId(id))),
                  },
                  clickhouse_settings: { mutations_sync: '2' },
                });
                tableDeleted += Math.max(0, deletable.length - (await countSideSurvivors(deletable)));
              }
              if (stopped) {
                remaining = true;
                break;
              }
              if (blocked) {
                remaining = true;
                break;
              }
              const after = await countSide();
              remaining = after > 0;
              if (!remaining) break;
            }
          }
        }
        deleted += tableDeleted;
        if (remaining) complete = false;
        tables.push({ table: spec.table, deleted: tableDeleted, remaining });
        if (stopped) break;
      }
      return { deleted, complete, tables };
    },
    async countEvents(workspaceId, q) {
      const rs = await query(workspaceId, countQuery(workspaceId, q, await protectedReadFor(workspaceId)));
      return (await rs.json<{ anonymous_id: string; user_id: string; c: number }>()).map(countRow);
    },
    async *countEventsBatches(workspaceId, q, batchSize = 10_000) {
      const rs = await query(workspaceId, countQuery(workspaceId, q, await protectedReadFor(workspaceId)));
      let batch: { anonymousId: string; userId: string; count: number }[] = [];
      for await (const rows of rs.stream<{ anonymous_id: string; user_id: string; c: number }>()) {
        for (const row of rows) {
          batch.push(countRow(row.json()));
          if (batch.length >= batchSize) {
            yield batch;
            batch = [];
          }
        }
      }
      if (batch.length) yield batch;
    },
    async countMessageEvents(workspaceId, q) {
      // An empty scope means nobody: do not fall through to a workspace-wide read.
      if (q.profileIds && !q.profileIds.length) return [];
      const protectedRead = await protectedReadFor(workspaceId);
      const { conditions, params } = messageCountConditions(q);
      const scoped = await messageScopeFits(workspaceId, protectedRead, conditions, params);
      const rs = await query(workspaceId, messageEventCountQuery(workspaceId, q, protectedRead, scoped));
      return (await rs.json<{ profile_id: string; c: number | string }>()).map(messageCountRow);
    },
    async *countMessageEventsBatches(workspaceId, q, batchSize = 10_000) {
      const protectedRead = await protectedReadFor(workspaceId);
      const { conditions, params } = messageCountConditions(q);
      const scoped = await messageScopeFits(workspaceId, protectedRead, conditions, params);
      const rs = await query(workspaceId, messageEventCountQuery(workspaceId, q, protectedRead, scoped));
      let batch: { profileId: string; count: number }[] = [];
      for await (const rows of rs.stream<{ profile_id: string; c: number | string }>()) {
        for (const row of rows) {
          batch.push(messageCountRow(row.json()));
          if (batch.length >= batchSize) {
            yield batch;
            batch = [];
          }
        }
      }
      if (batch.length) yield batch;
    },
    async experimentCounts(workspaceId, q) {
      const protectedRead = await protectedReadFor(workspaceId);
      const rs = await query(workspaceId, {
        query: `WITH
            exposures AS (
              SELECT anonymous_id AS visitor, argMin(toString(properties.variant_id), timestamp) AS variant, min(timestamp) AS first
              FROM ${personReadSource('events', protectedRead)} FINAL
              WHERE workspace_id = {ws:UUID} AND name = 'Experience Viewed' AND toString(properties.experience_id) = {exp:String}
                AND toString(properties.version) = {version:String}
                AND anonymous_id != '' AND timestamp >= {since:DateTime64(3, 'UTC')}
              GROUP BY anonymous_id),
            goals AS (
              SELECT anonymous_id AS visitor, max(timestamp) AS last
              FROM ${personReadSource('events', protectedRead)} FINAL
              WHERE workspace_id = {ws:UUID} AND name = {goal:String} AND anonymous_id != '' AND timestamp >= {since:DateTime64(3, 'UTC')}
              GROUP BY anonymous_id)
          SELECT e.variant AS variant, count() AS exposed, countIf(g.visitor != '' AND g.last >= e.first) AS converted
          FROM exposures e LEFT JOIN goals g ON g.visitor = e.visitor
          GROUP BY e.variant ORDER BY e.variant`,
        query_params: {
          ws: workspaceId,
          exp: q.experienceId,
          // Variant ids are author-chosen and may be renamed between versions, so the exposure must
          // match the version the results describe (#758). The SDK records the number; ClickHouse's
          // JSON path reads back as a string here. An exposure with no version (a hand-rolled client,
          // or one from before the SDK sent it) matches no version and is deliberately left out
          // rather than guessed into v1.
          version: String(q.version),
          goal: q.goal ?? '',
          since: (q.since ?? new Date(0)).toISOString().replace('Z', ''),
        },
        format: 'JSONEachRow',
        clickhouse_settings: { join_use_nulls: 0 },
      });
      const since = (q.since ?? new Date(0)).toISOString().replace('Z', '');
      // Count the exposures the version filter above drops because they carry no version at all,
      // so results can say how many were excluded instead of leaving them unexplained (#758).
      const unversionedRs = await query(workspaceId, {
        query: `SELECT count() AS n FROM (
                  SELECT anonymous_id FROM ${personReadSource('events', protectedRead)} FINAL
                  WHERE workspace_id = {ws:UUID} AND name = 'Experience Viewed'
                    AND toString(properties.experience_id) = {exp:String}
                    AND coalesce(toString(properties.version), '') = ''
                    AND anonymous_id != '' AND timestamp >= {since:DateTime64(3, 'UTC')}
                  GROUP BY anonymous_id)`,
        query_params: { ws: workspaceId, exp: q.experienceId, since },
        format: 'JSONEachRow',
      });
      const [unversioned] = await unversionedRs.json<{ n: number | string }>();
      return {
        variants: (await rs.json<{ variant: string; exposed: number; converted: number }>()).map((r) => ({
          variant: r.variant,
          exposed: Number(r.exposed),
          converted: Number(r.converted),
        })),
        unversioned: Number(unversioned?.n ?? 0),
      };
    },
    async insertMessageEvents(events) {
      if (!events.length) return;
      const subject = await subjectHashesFor(events, opts.subjectKeys, profileSubjectSources).catch((err) => {
        noteSubjectKeyFailure();
        throw err;
      });
      await client.insert({
        table: 'message_events',
        format: 'JSONEachRow',
        clickhouse_settings: SYNC_INSERT,
        values: events.map((e, index) => ({
          workspace_id: e.workspaceId,
          message_id: e.messageId,
          event_id: e.eventId,
          type: e.type,
          at: e.at.replace('Z', ''),
          profile_id: e.profileId,
          channel: e.channel,
          purpose: e.purpose,
          provider: e.provider,
          template_id: e.templateId,
          template_version: e.templateVersion,
          journey_id: e.journeyId,
          variant: e.variant ?? '',
          reason: e.reason,
          url: e.url,
          // Message events carry a profile id and no anonymous/user id or address.
          ...subjectColumns(subject[index] ?? null, subject[index] ? 'full' : 'none'),
        })),
      });
    },
    async insertJourneyEvents(events) {
      if (!events.length) return;
      const subject = await subjectHashesFor(events, opts.subjectKeys, profileSubjectSources).catch((err) => {
        noteSubjectKeyFailure();
        throw err;
      });
      await client.insert({
        table: 'journey_events',
        format: 'JSONEachRow',
        clickhouse_settings: SYNC_INSERT,
        values: events.map((e, index) => ({
          workspace_id: e.workspaceId,
          journey_id: e.journeyId,
          version: e.version,
          participant_id: e.participantId,
          profile_id: e.profileId,
          node: e.node,
          type: e.type,
          seq: e.seq,
          at: e.at.replace('Z', ''),
          detail: e.detail,
          // Journey events carry a profile id and no anonymous/user id or address.
          ...subjectColumns(subject[index] ?? null, subject[index] ? 'full' : 'none'),
        })),
      });
    },
    async publishErasedSubjects(rows) {
      if (!rows.length) return;
      await client.insert({
        table: 'erased_subjects',
        format: 'JSONEachRow',
        ...abort(),
        ...queryId(),
        clickhouse_settings: SYNC_INSERT,
        values: rows.map((row) => ({
          workspace_id: row.workspaceId,
          kind: row.kind,
          key: row.key,
          key_version: row.keyVersion,
          erasure_id: row.erasureId,
          generation: row.generation,
          recorded_at: row.recordedAt.replace('Z', ''),
        })),
      });
    },
    async erasedSubjectKeys(workspaceId) {
      return readErasedSubjectKeys(workspaceId);
    },
    async erasedSubjectsVisible(workspaceId, keys) {
      if (!keys.length) return true;
      const rs = await query(workspaceId, {
        // A key is the HMAC of one identifier under one exclusion key version, so counting distinct
        // values present is the same as counting the exact rows. FINAL is the visibility check:
        // it reads the merged state a later query will see, not the insert's acknowledgement.
        query: `SELECT countDistinct(key) AS n FROM erased_subjects FINAL
                WHERE workspace_id = {ws:UUID} AND key IN {keys:Array(String)}`,
        query_params: { ws: workspaceId, keys: [...new Set(keys)] },
        format: 'JSONEachRow',
      });
      const [row] = await rs.json<{ n: number | string }>();
      return Number(row?.n ?? 0) === new Set(keys).size;
    },
    async withoutErasedSubjects(workspaceId, events) {
      return withoutErased(workspaceId, events);
    },
    async backfillSubjectKeys(o) {
      if (!opts.subjectKeys) throw new Error('the subject-key backfill needs an exclusion key hasher');
      const batchSize = Math.max(1, Math.trunc(o.batchSize ?? 5_000));
      const tables: SubjectKeyBackfillResult['tables'] = [];
      for (const workspaceId of o.workspaceIds) {
        const settings = await settingsFor(workspaceId);
        for (const spec of SUBJECT_KEY_BACKFILL_TABLES) {
          const state = await readBackfillCursor(client, spec.table, workspaceId);
          const batch = subjectKeyBackfillBatchQuery(spec, { workspaceId, cursor: state.cursor, limit: batchSize });
          const rs = await client.query({
            query: batch.query,
            query_params: batch.query_params,
            format: 'JSONEachRow',
            clickhouse_settings: settings,
          });
          const rows = await rs.json<Record<string, unknown>>();
          if (!rows.length) {
            const remaining = await uncoveredRows(client, spec, workspaceId, settings);
            const done = remaining === 0;
            // Reset the cursor whenever the forward scan is exhausted, even if the count is still
            // positive: an uncovered row behind the cursor can only be found by scanning again.
            await writeBackfillCursor(client, spec.table, workspaceId, {
              cursor: '',
              revision: state.revision + 1,
            });
            tables.push({ table: spec.table, workspaceId, advanced: false, remaining: !done, done });
            continue;
          }

          const hasher = await opts.subjectKeys(workspaceId);
          try {
            const version = Date.now();
            const values = await Promise.all(
              rows.map(async (row) => {
                const hashes: Partial<Record<SubjectKeyKind, string>> = {};
                for (const source of spec.sources) {
                  const value = row[source.column];
                  if (typeof value === 'string' && value) hashes[source.kind] = await hasher.hash(source.kind, value);
                }
                if (spec.clickIds) {
                  // The reader is total and also accepts the shapes earlier releases stored (a
                  // parsed `page.search` map, for one), so a historical row keeps the click-id keys
                  // it names and the pass never fails on it. An unexpected exception here is a
                  // dependency failure and propagates, so the pass is retried.
                  for (const [kind, value] of eventClickIds((row.context ?? {}) as Record<string, unknown>, String(row.timestamp ?? '')))
                    hashes[kind] = await hasher.hash(kind, value);
                }
                const out: Record<string, unknown> = {
                  workspace_id: workspaceId,
                  table_name: spec.table,
                  ...identityValues(spec, row),
                  subject_key_version: hasher.version,
                  subject_coverage: Object.keys(hashes).length ? 'ids_only' : 'none',
                  version,
                  recorded_at: new Date().toISOString().replace('Z', ''),
                };
                for (const column of Object.values(SUBJECT_KEY_COLUMNS)) out[column] = '';
                for (const [kind, value] of Object.entries(hashes)) out[SUBJECT_KEY_COLUMNS[kind as SubjectKeyKind]] = value as string;
                return out;
              }),
            );
            // A side-table insert, never a rewrite of the person row: a stale copy cannot
            // supersede a complete concurrent redelivery, and a timeout simply resumes from the
            // same cursor (the replacement key makes the retry idempotent).
            await client.insert({ table: 'subject_key_backfill', values, format: 'JSONEachRow', clickhouse_settings: SYNC_INSERT });
          } finally {
            hasher.dispose();
          }

          const lastRow = rows[rows.length - 1] as Record<string, unknown>;
          const nextCursor = JSON.stringify(Object.fromEntries(spec.sortColumns.map((column) => [column.name, lastRow[column.name]])));
          await writeBackfillCursor(client, spec.table, workspaceId, { cursor: nextCursor, revision: state.revision + 1 });
          tables.push({ table: spec.table, workspaceId, advanced: true, remaining: true, done: false });
        }
      }
      return { tables, done: tables.every((table) => table.done) };
    },
    async subjectKeyCoverage(workspaceIds) {
      const tables: SubjectKeyCoverageResult['tables'] = [];
      for (const workspaceId of workspaceIds) {
        const settings = await settingsFor(workspaceId);
        for (const spec of SUBJECT_KEY_BACKFILL_TABLES) {
          tables.push({ table: spec.table, workspaceId, pending: await uncoveredRows(client, spec, workspaceId, settings) });
        }
      }
      return { pending: tables.reduce((sum, table) => sum + table.pending, 0), tables };
    },
    async messageStats(workspaceId, q) {
      // The snapshot half of the union has not reached ClickHouse, so the protected view cannot
      // exclude it; check its profiles against the published ledger here (#1037 part 2).
      const pending = q.pendingEvents?.length ? await withoutErased(workspaceId, q.pendingEvents) : [];
      const protectedRead = await protectedReadFor(workspaceId);
      const { conditions, params } = messageStatsConditions(q);
      params.ws = workspaceId;
      // Without a queued half, an id-scoped read bounds the ledger set to the keys its own scope can
      // carry (#1037 part 2 review); the bound is derived inside the statement (#1195). With queued
      // rows the union stays on the view; both halves are then filtered by the same predicate.
      const scoped = pending.length ? false : await messageScopeFits(workspaceId, protectedRead, conditions, params);
      const where = conditions.join(' AND ');
      const source = pending.length
        ? `${messageEventsWithPending(pending, params, protectedRead)} AS m`
        : scoped
          ? `${messageScopedSource(where, messageStatsConditions(q, 'sm').conditions.join(' AND '))} AS m`
          : `${personReadSource('message_events', protectedRead)} AS m FINAL`;
      const rs = await query(workspaceId, {
        query: `SELECT type, uniqExact(message_id) AS c FROM ${source}
                ${scoped ? '' : `WHERE ${where}`}
                GROUP BY type`,
        query_params: params,
        format: 'JSONEachRow',
        ...(scoped ? { clickhouse_settings: SCOPED_SNAPSHOT_SETTINGS } : {}),
      });
      return Object.fromEntries((await rs.json<{ type: string; c: number }>()).map((r) => [r.type, Number(r.c)]));
    },
    async messageVariantStats(workspaceId, journeyId) {
      // Aggregate by the message's variant in ClickHouse: filtering by the broadcast's journey id
      // keeps the query parameter a single string however large the subject test is (#1153).
      const protectedRead = await protectedReadFor(workspaceId);
      const rs = await query(workspaceId, {
        query: `SELECT variant, type, uniqExact(message_id) AS c
                FROM ${personReadSource('message_events', protectedRead)} FINAL
                WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} AND variant != ''
                  AND type IN ('delivered', 'opened', 'clicked')
                GROUP BY variant, type`,
        query_params: { ws: workspaceId, j: journeyId },
        format: 'JSONEachRow',
      });
      const out: Record<string, { delivered: number; opened: number; clicked: number }> = {};
      for (const r of await rs.json<{ variant: string; type: string; c: number | string }>()) {
        const slot = out[r.variant] ?? { delivered: 0, opened: 0, clicked: 0 };
        out[r.variant] = slot;
        if (r.type === 'delivered' || r.type === 'opened' || r.type === 'clicked') slot[r.type] = Number(r.c);
      }
      return out;
    },
    async journeyCounts(workspaceId, journeyId) {
      const protectedRead = await protectedReadFor(workspaceId);
      const rs = await query(workspaceId, {
        query: `SELECT node, type, uniqExact(participant_id) AS c FROM ${personReadSource('journey_events', protectedRead)} FINAL
                WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} GROUP BY node, type`,
        query_params: { ws: workspaceId, j: journeyId },
        format: 'JSONEachRow',
      });
      return (await rs.json<{ node: string; type: string; c: number }>()).map((r) => ({ node: r.node, type: r.type, count: Number(r.c) }));
    },
    async journeySplitArms(workspaceId, q) {
      const from = q.from?.toISOString().replace('Z', '');
      const to = q.to?.toISOString().replace('Z', '');
      // One deterministic take per participant: the first split step by (at, seq, detail). A
      // participant that loops back through the same split keeps that first arm, so its outcomes
      // cannot be counted twice or attributed to two arms (#369).
      const protectedRead = await protectedReadFor(workspaceId);
      const parse = (r: { participant_id: number | string; profile_id: string; variant: string; at: string }) => ({
        participantId: Number(r.participant_id),
        profileId: r.profile_id,
        arm: Number(r.variant.slice('variant '.length)) - 1,
        at: Date.parse(`${String(r.at).replace(' ', 'T')}Z`),
      });
      if (!q.onPage) {
        const rows = await query(workspaceId, {
          query: `SELECT participant_id, profile_id, variant, at FROM (
                    SELECT participant_id, profile_id, detail AS variant, at FROM ${personReadSource('journey_events', protectedRead)} FINAL
                    WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} AND node = {n:String} AND type = 'step'
                      AND startsWith(detail, 'variant ')
                    ORDER BY at ASC, seq ASC, detail ASC LIMIT 1 BY participant_id
                  ) WHERE 1
                  ${from ? "AND at >= {from:DateTime64(3, 'UTC')}" : ''}
                  ${to ? "AND at <= {to:DateTime64(3, 'UTC')}" : ''}
                  ORDER BY at ASC, participant_id ASC`,
          query_params: { ws: workspaceId, j: q.journeyId, n: q.node, ...(from ? { from } : {}), ...(to ? { to } : {}) },
          format: 'JSONEachRow',
        });
        return (await rows.json<{ participant_id: number | string; profile_id: string; variant: string; at: string }>()).map(parse);
      }
      // A split may hold hundreds of thousands of takes, so walk it with a stable keyset over the
      // participant id, a bounded page at a time (#1108). The window is applied here rather than in
      // SQL: a page is a page of deduped participants before the window, so a page that is wholly
      // outside it cannot end the walk early. The first take of a participant is chosen before the
      // window, exactly as the unbounded read does.
      const pageSize = Math.max(1, Math.trunc(q.pageSize ?? 10_000));
      const fromMs = q.from?.getTime();
      const toMs = q.to?.getTime();
      let after: number | undefined;
      for (;;) {
        const rows = await query(workspaceId, {
          query: `SELECT participant_id, profile_id, variant, at FROM (
                    SELECT participant_id, profile_id, detail AS variant, at FROM ${personReadSource('journey_events', protectedRead)} FINAL
                    WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} AND node = {n:String} AND type = 'step'
                      AND startsWith(detail, 'variant ')
                      ${after === undefined ? '' : 'AND participant_id > {after:UInt64}'}
                    ORDER BY at ASC, seq ASC, detail ASC LIMIT 1 BY participant_id
                  ) WHERE 1
                  ${after === undefined ? '' : 'AND participant_id > {after:UInt64}'}
                  ORDER BY participant_id ASC LIMIT {pageSize:UInt32}`,
          query_params: {
            ws: workspaceId,
            j: q.journeyId,
            n: q.node,
            pageSize,
            ...(after === undefined ? {} : { after }),
          },
          format: 'JSONEachRow',
        });
        const page = (await rows.json<{ participant_id: number | string; profile_id: string; variant: string; at: string }>()).map(parse);
        const inRange = page.filter((row) => (fromMs === undefined || row.at >= fromMs) && (toMs === undefined || row.at <= toMs));
        if (inRange.length) await q.onPage(inRange);
        if (page.length < pageSize) break;
        after = page[page.length - 1]!.participantId;
      }
      return [];
    },

    async journeyHoldoutOutcomes(workspaceId, q) {
      const from = q.from?.toISOString().replace('Z', '');
      const to = q.to?.toISOString().replace('Z', '');
      const protectedRead = await protectedReadFor(workspaceId);
      if (q.profileIds !== undefined && !q.profileIds.length)
        return { converted: [], unsubscribed: [], convertedAt: [], unsubscribedAt: [] };
      // Scope the read to one page of people when the caller has one (#1096). The ids include the
      // page's merged-away profile ids, so an outcome stored under an old id is still read for its
      // page. Chunk the array like conversionEvents: one form field stays below the transport limit.
      const profileScopes: string[] = [];
      const profileParams: Record<string, unknown> = {};
      if (q.profileIds) {
        let chunk: string[] = [];
        let bytes = 2;
        const flush = () => {
          if (!chunk.length) return;
          const name = `profiles${profileScopes.length}`;
          profileScopes.push(`profile_id IN {${name}:Array(String)}`);
          profileParams[name] = chunk;
          chunk = [];
          bytes = 2;
        };
        for (const value of q.profileIds) {
          const size = Buffer.byteLength(JSON.stringify(value)) * 2 + 3;
          if (size > 64 * 1024) throw new Error('Measurement identifier exceeds the query parameter size limit');
          if (bytes + size > 64 * 1024) flush();
          chunk.push(value);
          bytes += size;
        }
        flush();
      }
      const profileScope = profileScopes.length ? `AND (${profileScopes.join(' OR ')})` : '';
      const converted = await query(workspaceId, {
        query: `SELECT DISTINCT profile_id, participant_id, at FROM ${personReadSource('journey_events', protectedRead)} FINAL
                WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} AND type = 'converted'
                ${from ? "AND at >= {from:DateTime64(3, 'UTC')}" : ''}
                ${to ? "AND at <= {to:DateTime64(3, 'UTC')}" : ''}
                ${profileScope}`,
        query_params: { ws: workspaceId, j: q.journeyId, ...(from ? { from } : {}), ...(to ? { to } : {}), ...profileParams },
        format: 'JSONEachRow',
      });
      const unsubscribed = await query(workspaceId, {
        query: `SELECT DISTINCT profile_id, at FROM ${personReadSource('message_events', protectedRead)} FINAL
                WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} AND type = 'unsubscribed' AND channel = 'email'
                ${from ? "AND at >= {from:DateTime64(3, 'UTC')}" : ''}
                ${to ? "AND at <= {to:DateTime64(3, 'UTC')}" : ''}
                ${profileScope}`,
        query_params: { ws: workspaceId, j: q.journeyId, ...(from ? { from } : {}), ...(to ? { to } : {}), ...profileParams },
        format: 'JSONEachRow',
      });
      const convertedRows = await converted.json<{ profile_id: string; participant_id: number | string; at: string }>();
      const unsubscribedRows = await unsubscribed.json<{ profile_id: string; at: string }>();
      const at = (value: string) => Date.parse(`${String(value).replace(' ', 'T')}Z`);
      return {
        converted: [...new Set(convertedRows.map((r) => r.profile_id))],
        unsubscribed: [...new Set(unsubscribedRows.map((r) => r.profile_id))],
        convertedAt: convertedRows.map((r) => ({
          profileId: r.profile_id,
          participantId: Number(r.participant_id),
          at: at(r.at),
        })),
        unsubscribedAt: unsubscribedRows.map((r) => ({ profileId: r.profile_id, at: at(r.at) })),
      };
    },
    async conversionEvents(workspaceId, q) {
      if (!q.names.length) return [];
      if (
        (q.profileIds !== undefined || q.identifiers !== undefined) &&
        !q.profileIds?.length &&
        !q.identifiers?.anonymousIds.length &&
        !q.identifiers?.userIds.length
      )
        return [];
      // No workspace-wide row cap: the old LIMIT 100_000 silently dropped later conversions
      // (#366). Walk the window with a bounded keyset over the table's full replacing key, so
      // events that tie on timestamp and event id are neither skipped nor repeated (#786).
      // This is a keyset walk, not a snapshot: an event that arrives behind the cursor during a
      // run is counted in the next run, not this one. Scope by profile/identifier where the
      // caller knows the measured people, which also keeps the scan small.
      const scopes: string[] = [];
      const scopeParams: Record<string, unknown> = {};
      // Multipart still limits each form field (128 KiB by default). Keep arrays below
      // 64 KiB, allowing for ClickHouse string escaping, and OR their predicates together.
      const addScope = (column: string, values: string[]) => {
        let chunk: string[] = [];
        let bytes = 2;
        const flush = () => {
          if (!chunk.length) return;
          const name = `scope${scopes.length}`;
          scopes.push(`${column} IN {${name}:Array(String)}`);
          scopeParams[name] = chunk;
          chunk = [];
          bytes = 2;
        };
        for (const value of values) {
          const size = Buffer.byteLength(JSON.stringify(value)) * 2 + 3;
          if (size > 64 * 1024) throw new Error('Measurement identifier exceeds the query parameter size limit');
          if (bytes + size > 64 * 1024) flush();
          chunk.push(value);
          bytes += size;
        }
        flush();
      };
      addScope('profile_id', q.profileIds ?? []);
      addScope('anonymous_id', q.identifiers?.anonymousIds ?? []);
      addScope('user_id', q.identifiers?.userIds ?? []);
      const scope = scopes.length ? `AND (${scopes.join(' OR ')})` : '';
      const pageSize = Math.max(1, Math.trunc(q.pageSize ?? 10_000));
      const events: ConversionEvent[] = [];
      const protectedRead = await protectedReadFor(workspaceId);
      let after: { timestamp: string; name: string; anonymousId: string; eventId: string } | undefined;
      for (;;) {
        const rs = await query(workspaceId, {
          query: `SELECT event_id, profile_id, anonymous_id, user_id, name, timestamp, properties FROM ${personReadSource('events', protectedRead)} FINAL
                  WHERE workspace_id = {ws:UUID} AND name IN {names:Array(String)}
                    AND timestamp >= {from:DateTime64(3, 'UTC')} AND timestamp <= {to:DateTime64(3, 'UTC')}
                    ${scope}
                    ${
                      after
                        ? "AND (timestamp, name, anonymous_id, event_id) > ({after:DateTime64(3, 'UTC')}, {afterName:String}, {afterAnonymousId:String}, {afterId:String})"
                        : ''
                    }
                  ORDER BY timestamp ASC, name ASC, anonymous_id ASC, event_id ASC LIMIT {pageSize:UInt32}`,
          query_params: {
            ws: workspaceId,
            names: q.names,
            from: q.from.toISOString().replace('Z', ''),
            to: q.to.toISOString().replace('Z', ''),
            pageSize,
            ...scopeParams,
            ...(after
              ? { after: after.timestamp, afterName: after.name, afterAnonymousId: after.anonymousId, afterId: after.eventId }
              : {}),
          },
          format: 'JSONEachRow',
        });
        const rows = await rs.json<Record<string, never>>();
        const page: ConversionEvent[] = rows.map((r) => ({
          profileId: r.profile_id,
          anonymousId: r.anonymous_id,
          userId: r.user_id,
          name: r.name,
          timestamp: Date.parse(`${String(r.timestamp).replace(' ', 'T')}Z`),
          properties: typeof r.properties === 'string' ? JSON.parse(r.properties) : (r.properties as Record<string, unknown>),
        }));
        // A consumer that folds pages keeps memory bounded; without one, keep the historical
        // whole-window return.
        if (q.onPage) await q.onPage(page);
        else events.push(...page);
        if (rows.length < pageSize) break;
        const last = rows[rows.length - 1]!;
        after = {
          timestamp: String(last.timestamp),
          name: String(last.name),
          anonymousId: String(last.anonymous_id),
          eventId: String(last.event_id),
        };
      }
      return events;
    },
    async unsubscribedProfiles(workspaceId, q) {
      if (!q.journeyIds.length) return [];
      const protectedRead = await protectedReadFor(workspaceId);
      if (q.profileIds !== undefined && !q.profileIds.length) return [];
      // Scope by the people being counted when the caller has them (the holdout report's page),
      // so a page reads only its own unsubscribes. Chunk the array like conversionEvents: one
      // form field stays below the transport limit on a large page (#972 review).
      const profileScopes: string[] = [];
      const profileParams: Record<string, unknown> = {};
      if (q.profileIds) {
        let chunk: string[] = [];
        let bytes = 2;
        const flush = () => {
          if (!chunk.length) return;
          const name = `profiles${profileScopes.length}`;
          profileScopes.push(`profile_id IN {${name}:Array(String)}`);
          profileParams[name] = chunk;
          chunk = [];
          bytes = 2;
        };
        for (const value of q.profileIds) {
          const size = Buffer.byteLength(JSON.stringify(value)) * 2 + 3;
          if (size > 64 * 1024) throw new Error('Measurement identifier exceeds the query parameter size limit');
          if (bytes + size > 64 * 1024) flush();
          chunk.push(value);
          bytes += size;
        }
        flush();
      }
      const profileScope = profileScopes.length ? `AND (${profileScopes.join(' OR ')})` : '';
      const from = q.from?.toISOString().replace('Z', '');
      const to = q.to?.toISOString().replace('Z', '');
      const rs = await query(workspaceId, {
        query: `SELECT DISTINCT profile_id FROM ${personReadSource('message_events', protectedRead)} FINAL
                WHERE workspace_id = {ws:UUID} AND journey_id IN {ids:Array(String)}
                  AND type = 'unsubscribed' AND channel = 'email'
                ${from ? "AND at >= {from:DateTime64(3, 'UTC')}" : ''}
                ${to ? "AND at <= {to:DateTime64(3, 'UTC')}" : ''}
                ${profileScope}`,
        query_params: {
          ws: workspaceId,
          ids: q.journeyIds,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...profileParams,
        },
        format: 'JSONEachRow',
      });
      return (await rs.json<{ profile_id: string }>()).map((r) => r.profile_id);
    },
    async messageEventsOf(workspaceId, filter, limit = 200) {
      const protectedRead = await protectedReadFor(workspaceId);
      const rs = await query(workspaceId, {
        query: `SELECT * FROM ${personReadSource('message_events', protectedRead)} FINAL WHERE workspace_id = {ws:UUID}
                ${filter.messageIds ? 'AND message_id IN {ids:Array(String)}' : ''}
                ${filter.profileId ? 'AND profile_id = {profile:String}' : ''}
                ORDER BY at DESC LIMIT {limit:UInt32}`,
        query_params: { ws: workspaceId, ids: filter.messageIds ?? [], profile: filter.profileId ?? '', limit },
        format: 'JSONEachRow',
      });
      return (await rs.json<Record<string, never>>()).map((r) => ({
        workspaceId: r.workspace_id,
        messageId: r.message_id,
        eventId: r.event_id,
        type: r.type,
        at: `${String(r.at).replace(' ', 'T')}Z`,
        profileId: r.profile_id,
        channel: r.channel,
        purpose: r.purpose,
        provider: r.provider,
        templateId: r.template_id,
        templateVersion: r.template_version,
        journeyId: r.journey_id,
        reason: r.reason,
        url: r.url,
      }));
    },
    async ping() {
      return (await client.ping()).success;
    },
    async close() {
      await client.close();
    },
  };
}

declare module '@agentic-marketing/commands' {
  interface Services {
    events: EventStore;
    bus: import('./bus').EventBus;
  }
}

/** Drops a ClickHouse database (tests, and resetting a development install). */
export async function resetClickHouse(url: string, database: string) {
  const root = createClient(clientOptions(url));
  await root.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  await root.close();
}
