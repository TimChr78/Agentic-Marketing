import { sleep } from '@agentic-marketing/core';
import type { EventStore } from './clickhouse';
import type { BusEvent } from './schema';

/**
 * The identifier kinds the durable erasure-key ledger and the ClickHouse subject columns share
 * (#1037). They match `erasure_keys.kind` in PostgreSQL and `erased_subjects.kind` in ClickHouse.
 */
export type SubjectKeyKind = 'profile' | 'anonymous_id' | 'user_id' | 'email' | 'phone';

/** The keyed e-mail and phone hashes for one stored event, when its row carried them. */
export interface SubjectKeyHashes {
  emailHash: string;
  phoneHash: string;
  /** The matching data key id behind the hashes; empty when neither was computed. */
  version: string;
}

/**
 * Computes the keyed e-mail/phone hashes for a batch of events before they are stored. The
 * implementation lives with the key provider (packages/profiles); an event store without one
 * still stores the ids, and the two hash columns stay empty.
 */
export type SubjectKeyResolver = (events: readonly BusEvent[]) => Promise<readonly (SubjectKeyHashes | null)[]>;

/** One row of the ClickHouse `erased_subjects` table, published from the PostgreSQL ledger. */
export interface ErasedSubjectRow {
  workspaceId: string;
  kind: SubjectKeyKind;
  key: string;
  keyVersion: string;
  erasureId: string;
  /** Monotonic erasure generation; a later read rejects exclusion state older than it covers. */
  generation: number;
  /** ISO timestamp, stored as DateTime64(3, 'UTC'). */
  recordedAt: string;
}

/**
 * The person-linked ClickHouse tables and how their historical rows map onto the subject keys.
 * `subject_profile_id` is the profile id the row already carries; events additionally carry the
 * anonymous and user ids they were written with. Historical rows cannot supply e-mail or phone
 * hashes: those traits are never stored with an event.
 */
export const SUBJECT_KEY_BACKFILL_TABLES = [
  {
    table: 'events',
    timeColumn: 'timestamp',
    subjectColumns: {
      subject_profile_id: 'profile_id',
      subject_anonymous_id: 'anonymous_id',
      subject_user_id: 'user_id',
    },
  },
  {
    table: 'message_events',
    timeColumn: 'at',
    subjectColumns: { subject_profile_id: 'profile_id' },
  },
  {
    table: 'journey_events',
    timeColumn: 'at',
    subjectColumns: { subject_profile_id: 'profile_id' },
  },
] as const satisfies readonly {
  table: string;
  timeColumn: string;
  subjectColumns: Readonly<Record<string, string>>;
}[];

export interface SubjectKeyBackfillTableResult {
  table: string;
  /** This call ran a mutation for the table's next partition. */
  advanced: boolean;
  /** Another partition still waits for the backfill. */
  remaining: boolean;
  /** A subject-key mutation is still running on the ClickHouse server. */
  pending: boolean;
}

export interface SubjectKeyBackfillResult {
  tables: SubjectKeyBackfillTableResult[];
  /** No table has a partition left, and nothing is still running. */
  done: boolean;
}

export interface SubjectKeyBackfillOptions {
  /** Partitions per table per call; the scheduler runs several calls before it pauses. */
  partitionsPerCall?: number;
}

export interface RunSubjectKeyBackfillOptions extends SubjectKeyBackfillOptions {
  /** Calls per turn before yielding, so a large install does not hold the event loop. */
  callsPerTurn?: number;
  pauseMs?: number;
  log?: (message: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * The scheduler job for historical rows (#1037 part 1): fills the subject-key columns of every
 * existing event, message-event and journey-event partition in bounded mutations, then returns.
 * It is resumable (the cursor is stored in ClickHouse and each row carries its own
 * `subject_keys_set` checkpoint) and idempotent (a repeated partition rewrites the same values).
 * A mutation still running on the server is never started twice. Nothing reads the new columns
 * yet, so the contract does not activate here.
 */
export async function runSubjectKeyBackfill(
  deps: { events: Pick<EventStore, 'backfillSubjectKeys'> },
  signal: AbortSignal,
  opts: RunSubjectKeyBackfillOptions = {},
): Promise<void> {
  const callsPerTurn = opts.callsPerTurn ?? 4;
  const pauseMs = opts.pauseMs ?? 1_000;
  while (!signal.aborted) {
    let result: SubjectKeyBackfillResult | undefined;
    try {
      for (let call = 0; call < callsPerTurn; call++) {
        result = await deps.events.backfillSubjectKeys({
          ...(opts.partitionsPerCall === undefined ? {} : { partitionsPerCall: opts.partitionsPerCall }),
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
      if (result) opts.log?.(`subject-key backfill complete (${result.tables.length} table(s))`);
      return;
    }
    if (signal.aborted) return;
    await sleep(pauseMs, signal);
  }
}
