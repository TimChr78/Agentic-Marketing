import { sleep } from '@agentic-marketing/core';
import type { EventStore } from './clickhouse';
import { CLICK_ID_TYPES, clickIdsOfEvent } from './clickIds';

/**
 * The identifier kinds the durable erasure-key ledger and the ClickHouse subject columns share
 * (#1037). They match `erasure_keys.kind` in PostgreSQL. Every value is HMAC_exclusion(kind,
 * normalised value) under the workspace exclusion key; no raw identifier is stored.
 */
export type SubjectKeyKind =
  | 'profile'
  | 'anonymous_id'
  | 'user_id'
  | 'alias_previous_id'
  | 'email'
  | 'phone'
  | (typeof CLICK_ID_TYPES)[number];

/** The supported subject-key kinds, in column order. */
export const SUBJECT_KEY_KINDS: readonly SubjectKeyKind[] = [
  'profile',
  'anonymous_id',
  'user_id',
  'alias_previous_id',
  'email',
  'phone',
  ...CLICK_ID_TYPES,
];

/** The ClickHouse column that keeps a kind's exclusion hash. */
export const SUBJECT_KEY_COLUMNS: Readonly<Record<SubjectKeyKind, string>> = {
  profile: 'subject_profile',
  anonymous_id: 'subject_anonymous',
  user_id: 'subject_user',
  alias_previous_id: 'subject_previous',
  email: 'subject_email',
  phone: 'subject_phone',
  gclid: 'subject_gclid',
  gbraid: 'subject_gbraid',
  wbraid: 'subject_wbraid',
  fbc: 'subject_fbc',
  fbp: 'subject_fbp',
  msclkid: 'subject_msclkid',
  li_fat_id: 'subject_li_fat_id',
  ttclid: 'subject_ttclid',
  ttp: 'subject_ttp',
  epik: 'subject_epik',
};

/**
 * How complete a row's subject hashes are. `full` is a writer that saw every identifier it could
 * (including an alias previousId and e-mail/phone traits); `ids_only` is a historical row whose
 * stored columns still supply profile/anonymous/user/click ids but not the rest; `none` is a row
 * with nothing to key, recorded so it is not retried.
 */
export type SubjectCoverage = 'full' | 'ids_only' | 'none';

/** The exclusion hashes for one row, and the exclusion key version that produced them. */
export interface SubjectKeyHashes {
  version: string;
  hashes: Partial<Record<SubjectKeyKind, string>>;
}

/**
 * Hashes one workspace's subject values with its exclusion key. Implemented next to the key
 * provider (packages/profiles); a store without one writes coverage `none`.
 */
export interface SubjectKeyHasher {
  /** The exclusion data key id; recorded on every value while that key is retained. */
  readonly version: string;
  hash(kind: SubjectKeyKind, value: string): Promise<string>;
  /** Zeroes the unwrapped key. Idempotent. */
  dispose(): void;
}

export type SubjectKeyHasherFactory = (workspaceId: string) => Promise<SubjectKeyHasher>;

/** One row of the ClickHouse `erased_subjects` table, published from the PostgreSQL ledger. */
export interface ErasedSubjectRow {
  workspaceId: string;
  kind: SubjectKeyKind;
  key: string;
  keyVersion: string;
  erasureId: string;
  /** Monotonic replacement version; a later read rejects exclusion state older than it covers. */
  generation: number;
  /** ISO timestamp, stored as DateTime64(3, 'UTC'). */
  recordedAt: string;
}

/** How one historical table's raw columns map onto subject kinds and its stable identity. */
export interface SubjectKeyBackfillTable {
  table: 'events' | 'message_events' | 'journey_events';
  /** The table's full replacing/order key, used for the keyset cursor and ORDER BY. */
  sortColumns: readonly { name: string; type: string }[];
  /**
   * The stable identity under which the side table keeps this row (PR 2 joins on it). It is the
   * table's complete replacing key minus `workspace_id`: events use name/anonymous_id/timestamp/
   * event_id because a client-supplied event id alone is not unique; message events use
   * message_id/type/event_id; journey events use journey_id/participant_id/seq/type.
   */
  identity: readonly { column: string; key: string }[];
  /** Raw columns whose values are hashed; click ids come from `context` for events. */
  sources: readonly { kind: SubjectKeyKind; column: string }[];
  /** Whether the row's `context` carries ad click ids. */
  clickIds: boolean;
}

export const SUBJECT_KEY_BACKFILL_TABLES: readonly SubjectKeyBackfillTable[] = [
  {
    table: 'events',
    sortColumns: [
      { name: 'workspace_id', type: 'UUID' },
      { name: 'name', type: 'String' },
      { name: 'anonymous_id', type: 'String' },
      { name: 'timestamp', type: "DateTime64(3, 'UTC')" },
      { name: 'event_id', type: 'String' },
    ],
    // This table's identity is its complete replacing key minus workspace_id. A client-supplied
    // event_id alone is not unique: two rows may share it and differ by name, anonymous id or
    // timestamp, and a side entry keyed by id alone would drop one of them.
    identity: [
      { column: 'name', key: 'key1' },
      { column: 'anonymous_id', key: 'key2' },
      { column: 'timestamp', key: 'key3' },
      { column: 'event_id', key: 'key4' },
    ],
    sources: [
      { kind: 'profile', column: 'profile_id' },
      { kind: 'anonymous_id', column: 'anonymous_id' },
      { kind: 'user_id', column: 'user_id' },
    ],
    clickIds: true,
  },
  {
    table: 'message_events',
    sortColumns: [
      { name: 'workspace_id', type: 'UUID' },
      { name: 'message_id', type: 'String' },
      { name: 'type', type: 'String' },
      { name: 'event_id', type: 'String' },
    ],
    identity: [
      { column: 'message_id', key: 'key1' },
      { column: 'type', key: 'key2' },
      { column: 'event_id', key: 'key3' },
    ],
    sources: [{ kind: 'profile', column: 'profile_id' }],
    clickIds: false,
  },
  {
    table: 'journey_events',
    sortColumns: [
      { name: 'workspace_id', type: 'UUID' },
      { name: 'journey_id', type: 'String' },
      { name: 'participant_id', type: 'UInt64' },
      { name: 'seq', type: 'UInt32' },
      { name: 'type', type: 'String' },
    ],
    identity: [
      { column: 'journey_id', key: 'key1' },
      { column: 'participant_id', key: 'key2' },
      { column: 'seq', key: 'key3' },
      { column: 'type', key: 'key4' },
    ],
    sources: [{ kind: 'profile', column: 'profile_id' }],
    clickIds: false,
  },
];

export interface SubjectKeyBackfillTableResult {
  table: string;
  workspaceId: string;
  /** This call wrote a side-table batch. */
  advanced: boolean;
  /** This call left historically uncovered rows for later. */
  remaining: boolean;
  /** This pass found no uncovered rows for the pair (the next revalidation checks again). */
  done: boolean;
}

export interface SubjectKeyBackfillResult {
  tables: SubjectKeyBackfillTableResult[];
  /** Every workspace and table is finished for this pass. */
  done: boolean;
}

export interface SubjectKeyBackfillOptions {
  /** Workspaces to backfill; the person tables are behind workspace row policies. */
  workspaceIds: readonly string[];
  /** Rows written to the side table per call per table and workspace. */
  batchSize?: number;
}

/** How many historical rows still lack coverage, per table and workspace. */
export interface SubjectKeyCoverageRow {
  table: string;
  workspaceId: string;
  pending: number;
}

export interface SubjectKeyCoverageResult {
  pending: number;
  tables: SubjectKeyCoverageRow[];
}

export interface RunSubjectKeyBackfillOptions extends Omit<SubjectKeyBackfillOptions, 'workspaceIds'> {
  /** Re-check interval once a pass finishes, so later legacy rows are not missed. */
  revalidateMs?: number;
  /** Calls per turn before yielding, so a large install does not hold the event loop. */
  callsPerTurn?: number;
  pauseMs?: number;
  /** The first transient-error backoff; it doubles each failure up to `maxBackoffMs`. */
  maxBackoffMs?: number;
  log?: (message: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * Whether an error means the schema this pass needs is absent (SKIP_MIGRATIONS): a ClickHouse
 * `UNKNOWN_TABLE` / `UNKNOWN_IDENTIFIER`, or a missing PostgreSQL relation or column. Only these
 * are permanent for the process; anything else (a timeout, a restart, a transient pool error) is
 * retried (#1140).
 */
export function isSchemaMissingError(err: unknown): boolean {
  const e = err as { code?: unknown; type?: unknown; message?: unknown } | null | undefined;
  // PostgreSQL: undefined_table (42P01) and undefined_column (42703).
  if (e?.code === '42P01' || e?.code === '42703') return true;
  // The ClickHouse client tags the server's exception type.
  if (e?.type === 'UNKNOWN_TABLE' || e?.type === 'UNKNOWN_IDENTIFIER') return true;
  const message = typeof e?.message === 'string' ? e.message : '';
  return /\bUNKNOWN_(?:TABLE|IDENTIFIER)\b/.test(message);
}

/**
 * The scheduler job for historical rows (#1037 part 1). It reads each workspace's uncovered rows,
 * hashes the ids it still stores with the exclusion key in the app, and writes the result to the
 * `subject_key_backfill` side table keyed by the row's stable identity. It never rewrites a
 * person-linked row, so a complete concurrent redelivery can never be superseded by a stale copy.
 * A pass is done only when the uncovered count is zero; the job then revalidates at a low frequency
 * instead of ever treating the backfill as permanently finished. The exclusion key never leaves
 * the app.
 *
 * A missing schema stops the pass permanently (the next process start retries once migrations have
 * run); a transient error is logged and retried with exponential backoff, so one ClickHouse timeout
 * does not disable the backfill for the scheduler's lifetime and strand erasure cleanups (#1140).
 */
export async function runSubjectKeyBackfill(
  deps: { events: Pick<EventStore, 'backfillSubjectKeys'>; workspaces: () => Promise<string[]> },
  signal: AbortSignal,
  opts: RunSubjectKeyBackfillOptions = {},
): Promise<void> {
  const callsPerTurn = opts.callsPerTurn ?? 4;
  const pauseMs = opts.pauseMs ?? 1_000;
  const revalidateMs = opts.revalidateMs ?? 60 * 60 * 1_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 60_000;
  let backoffMs = pauseMs;
  for (;;) {
    if (signal.aborted) return;
    let result: SubjectKeyBackfillResult | undefined;
    try {
      const workspaceIds = await deps.workspaces();
      for (let call = 0; call < callsPerTurn; call++) {
        result = await deps.events.backfillSubjectKeys({
          workspaceIds,
          ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
        });
        if (result.done || !result.tables.some((table) => table.advanced)) break;
        if (signal.aborted) return;
      }
      backoffMs = pauseMs;
    } catch (err) {
      opts.onError?.(err);
      // A missing table or column (SKIP_MIGRATIONS) stays permanent: retrying cannot add it.
      if (isSchemaMissingError(err)) return;
      if (signal.aborted) return;
      try {
        await sleep(backoffMs, signal);
      } catch {
        return;
      }
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      continue;
    }
    if (result?.done)
      opts.log?.(`subject-key backfill pass complete (${result.tables.length} table/workspace pair(s)); revalidating later`);
    if (signal.aborted) return;
    try {
      await sleep(result?.done ? revalidateMs : pauseMs, signal);
    } catch {
      return;
    }
  }
}

/** The click ids an event's context names, for the writer and the backfill. */
export function eventClickIds(context: Record<string, unknown>, timestamp: string): [SubjectKeyKind, string][] {
  const iso = timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
  const seenAt = Date.parse(iso) || Date.now();
  return Object.entries(clickIdsOfEvent(context, seenAt)).map(([kind, value]) => [kind as SubjectKeyKind, value as string]);
}

/**
 * Process-wide count of writes that failed because subject keys could not be hashed. The sink
 * retries on its own; a steadily rising count is the operator signal (`am_subject_key_failures_total`).
 */
let subjectKeyFailures = 0;

export function noteSubjectKeyFailure(): void {
  subjectKeyFailures += 1;
}

export function subjectKeyFailureCount(): number {
  return subjectKeyFailures;
}
