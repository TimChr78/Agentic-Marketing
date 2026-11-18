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

/** The exclusion hashes for one row, and the exclusion key version that produced them. */
export interface SubjectKeyHashes {
  version: string;
  hashes: Partial<Record<SubjectKeyKind, string>>;
}

/**
 * Hashes one workspace's subject values with its exclusion key. Implemented next to the key
 * provider (packages/profiles); an event store without one writes no subject hashes and leaves
 * `subject_keys_set` at 0.
 */
export interface SubjectKeyHasher {
  /** The exclusion data key id; recorded on every value so a planned re-key is interpretable. */
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

/** How one historical table's raw columns map onto subject kinds. */
export interface SubjectKeyBackfillTable {
  table: 'events' | 'message_events' | 'journey_events';
  /** The table's full replacing/order key, used for the keyset cursor and ORDER BY. */
  sortColumns: readonly { name: string; type: string }[];
  /** Raw columns whose values are hashed; click ids come from `context` for events. */
  sources: readonly { kind: SubjectKeyKind; column: string }[];
  /** Whether the row's `context` carries ad click ids. */
  clickIds: boolean;
}

/**
 * The person-linked ClickHouse tables and the historical rows' raw sources. E-mail and phone are
 * absent: the event store never kept those traits, so a historical event can only be matched by
 * its ids and click ids (documented in security-and-privacy.md).
 */
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
    sources: [{ kind: 'profile', column: 'profile_id' }],
    clickIds: false,
  },
];

export interface SubjectKeyBackfillTableResult {
  table: string;
  workspaceId: string;
  /** This call wrote a batch back with its subject hashes. */
  advanced: boolean;
  /** This call left unprocessed rows for a later batch or dirty pass. */
  remaining: boolean;
  /** The workspace's backfill is finished (a FINAL count of unprocessed rows was zero). */
  done: boolean;
}

export interface SubjectKeyBackfillResult {
  tables: SubjectKeyBackfillTableResult[];
  /** Every workspace and table is finished. */
  done: boolean;
}

export interface SubjectKeyBackfillOptions {
  /** Workspaces to backfill; the person tables are behind workspace row policies. */
  workspaceIds: readonly string[];
  /** Rows written back per call per table and workspace. */
  batchSize?: number;
}

export interface RunSubjectKeyBackfillOptions extends Omit<SubjectKeyBackfillOptions, 'workspaceIds'> {
  /** Calls per turn before yielding, so a large install does not hold the event loop. */
  callsPerTurn?: number;
  pauseMs?: number;
  log?: (message: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * The scheduler job for historical rows (#1037 part 1): reads each workspace's unprocessed rows,
 * hashes their identifiers with the exclusion key in the app, writes the rows back with the hash
 * columns and `subject_keys_set = 1`, and only reports done when a FINAL count of unprocessed rows
 * is zero. A delayed legacy row that sorts before the cursor is caught by that count and revisited
 * in a FINAL pass. Re-inserting a row is idempotent (same replacing key), so a timeout is retried
 * from the persisted cursor rather than guessed at. The exclusion key never leaves the app.
 */
export async function runSubjectKeyBackfill(
  deps: { events: Pick<EventStore, 'backfillSubjectKeys'>; workspaces: () => Promise<string[]> },
  signal: AbortSignal,
  opts: RunSubjectKeyBackfillOptions = {},
): Promise<void> {
  const callsPerTurn = opts.callsPerTurn ?? 4;
  const pauseMs = opts.pauseMs ?? 1_000;
  while (!signal.aborted) {
    let result: SubjectKeyBackfillResult | undefined;
    try {
      const workspaceIds = await deps.workspaces();
      for (let call = 0; call < callsPerTurn; call++) {
        result = await deps.events.backfillSubjectKeys({
          workspaceIds,
          ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
        });
        const progressed = result.tables.some((t) => t.advanced);
        if (result.done || !progressed) break;
        if (signal.aborted) return;
      }
    } catch (err) {
      // A missing column or table (SKIP_MIGRATIONS) stops this pass; the next start retries.
      opts.onError?.(err);
      return;
    }
    if (!result || result.done) {
      if (result) opts.log?.(`subject-key backfill complete (${result.tables.length} table/workspace pair(s))`);
      return;
    }
    if (signal.aborted) return;
    await sleep(pauseMs, signal);
  }
}

/** The click ids an event's context names, for the writer and the backfill. */
export function eventClickIds(context: Record<string, unknown>, timestamp: string): [SubjectKeyKind, string][] {
  const iso = timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
  const seenAt = Date.parse(iso) || Date.now();
  return Object.entries(clickIdsOfEvent(context, seenAt)).map(([kind, value]) => [kind as SubjectKeyKind, value as string]);
}
