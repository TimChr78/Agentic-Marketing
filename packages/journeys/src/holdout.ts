import {
  type ArmResult,
  analyseHoldout,
  artifactTypes,
  type HoldoutVerdict,
  holdoutBelowK,
  holdoutHashVersion,
  holdoutWinners,
  K,
  MERGE_MAX_HOPS,
  mergeComponentCtes,
  type SuppressedArmResult,
  suppressHoldout,
} from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { outboxPublicationBarrier, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { and, eq, sql } from 'drizzle-orm';

// Holdout helpers moved to @agentic-marketing/artifacts so campaigns measure with the same
// assignment and statistics. Re-exported here because journeys.holdoutResult and its tests use
// them from this package.
export {
  type ArmCounts,
  type ArmResult,
  analyseHoldout,
  armFor,
  assignHoldout,
  type HoldoutAnalysis,
  type HoldoutArm,
  type HoldoutAssignment,
  type HoldoutConfig,
  type HoldoutScope,
  type HoldoutVerdict,
  holdoutBucket,
  holdoutDetail,
  holdoutHashVersion,
  holdoutParticipantId,
  newcombeDifference,
  wilsonInterval,
  Z_95,
} from '@agentic-marketing/artifacts';

export interface JourneyHoldoutResult {
  journeyId: string;
  controlGroup: { percent: number; minSampleSize: number; hashVersion: string };
  from: string | null;
  to: string | null;
  /** The k-anonymity floor the result was measured against. */
  k: number;
  control: ArmResult | SuppressedArmResult;
  treatment: ArmResult | SuppressedArmResult;
  absoluteLift: number | null;
  relativeLift: number | null;
  ci95: [number, number] | null;
  minSampleSizeMet: boolean;
  verdict: HoldoutVerdict;
  note: string;
  /** True when an arm held fewer than k people, so no count, rate or lift is reported. */
  suppressed: boolean;
}

/**
 * The most profiles one winners page may expand to when its outcomes are resolved (#1096). A page
 * is 1,000 people, so a page past this bound has an enormous merge family; like the campaign
 * report's identity-map guard (#986), the page is then matched on the profile id stored with the
 * event instead of holding the family in memory. Tests inject a smaller bound through
 * `computeJourneyHoldout`'s `pageProfileLimit`.
 */
export const JOURNEY_HOLDOUT_PAGE_PROFILE_LIMIT = 100_000;

/** Why one page of people could not be resolved to its merge family (#1096). */
export type PageUnresolved = 'over-limit' | 'deep';

const DEFAULT_JOURNEY_HOLDOUT_PAGE_SIZE = 1_000;

/** The winners page size; tests override it, production keeps the default (never env). */
let journeyHoldoutPageSize = DEFAULT_JOURNEY_HOLDOUT_PAGE_SIZE;

/**
 * Test-only override for the holdout report's winners page size (#1096). The value is an internal
 * bound, not configuration, so it is not read from the environment; a test sets it to cross a page
 * boundary without a large fixture and passes null to restore the default.
 */
export function setJourneyHoldoutPageSizeForTests(size: number | null): void {
  journeyHoldoutPageSize = size === null ? DEFAULT_JOURNEY_HOLDOUT_PAGE_SIZE : Math.max(1, Math.trunc(size));
}

export interface PageOutcomeScope {
  profileIds: string[];
  byProfile: Map<string, string>;
  /** Null when the page resolved; otherwise the reason it could not, for the report note. */
  unresolved: PageUnresolved | null;
}

/**
 * The profile ids whose outcomes belong to one page of people, and which person each resolves to:
 * every member of the page people's merge components (#1093), so an outcome stored under a
 * merged-away id is still read for the person it became. The read is bounded by `limit`; above it
 * the page is not resolved, and the caller matches on the stored profile id only. A component row
 * at `MERGE_MAX_HOPS` means the family is corruptly deep, which is unresolved for the same reason.
 *
 * The ids are resolved to their person first, so a caller may pass either representatives (the
 * holdout's winners) or raw ids (a split's participants, which may be merged-away).
 */
export async function pageOutcomeScope(tx: Tx, workspaceId: string, people: readonly string[], limit: number): Promise<PageOutcomeScope> {
  const { rows } = await tx.execute<{ representative: string; profile_id: string; depth: number }>(sql`
    WITH RECURSIVE ${mergeComponentCtes(workspaceId, {
      seeds: sql`SELECT DISTINCT unnest(${sql.param([...people])}::text[]) AS id`,
      componentOf: sql`SELECT DISTINCT representative COLLATE "default" AS rep FROM merge_representative`,
    })}
    SELECT representative, profile_id, depth FROM merge_component
    LIMIT ${limit + 1}`);
  if (rows.length > limit) return { profileIds: [...people], byProfile: new Map(), unresolved: 'over-limit' };
  if (rows.some((row) => row.depth >= MERGE_MAX_HOPS)) return { profileIds: [...people], byProfile: new Map(), unresolved: 'deep' };
  return {
    profileIds: rows.map((row) => row.profile_id),
    byProfile: new Map(rows.map((row) => [row.profile_id, row.representative])),
    unresolved: null,
  };
}

/** The note contribution for each unresolved cause, so a deep family never claims an id count. */
export function unresolvedOutcomeNote(reason: PageUnresolved, limit: number): string {
  return reason === 'over-limit'
    ? `One page of people has more than ${limit} merge-family profiles to resolve, so its outcomes are matched on the profile id stored with the event.`
    : `A merge family is ${MERGE_MAX_HOPS} or more merges deep and could not be resolved, so its outcomes are matched on the profile id stored with the event.`;
}

/**
 * The note a report carries while its journey's `journey_event` outbox rows are still pending or
 * failed. Publication is asynchronous (#1244), so a verdict computed now could rest on events that
 * have not reached ClickHouse. `what` names what the report withholds.
 */
export function incompletePublicationNote(publication: { outstanding: number; failed: number }, what: string): string {
  const reasons = [
    publication.outstanding ? `${publication.outstanding} pending` : '',
    publication.failed ? `${publication.failed} failed` : '',
  ]
    .filter(Boolean)
    .join(' and ');
  // A failed row has used its retries and stays failed until an operator requeues it, so the note
  // names the command rather than suggesting the report will recover on its own.
  const requeue = publication.failed ? ' Requeue the failed rows with `am outbox --kind journey_event` once ClickHouse is reachable.' : '';
  return `Publication of this journey's journey events is incomplete (${reasons}), so ${what} until they are published.${requeue}`;
}

/**
 * The computation behind journeys.holdoutResult, exported so campaign evaluation can report a
 * journey member's uplift without reimplementing the statistics or the assignment query.
 */
export async function computeJourneyHoldout(
  deps: {
    tx: Tx;
    events: EventStore;
    workspaceId: string;
    /**
     * The most profiles one winners page may expand to when resolving outcomes (#1096). Internal,
     * never environment configuration; tests inject a small value to exercise the guard.
     */
    pageProfileLimit?: number;
  },
  journeyId: string,
  range: { from?: string; to?: string } = {},
): Promise<JourneyHoldoutResult> {
  const [a] = await deps.tx
    .select({ publishedVersion: schema.artifacts.publishedVersion })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, journeyId));
  if (!a) throw new AppError('not_found', `No journey ${journeyId}.`);
  if (!a.publishedVersion)
    throw new AppError('not_found', `Journey ${journeyId} has no published version; publish it before measuring uplift.`);
  const [v] = await deps.tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, journeyId), eq(schema.artifactVersions.number, a.publishedVersion)));
  if (!v) throw new AppError('not_found', `Journey ${journeyId} has no published version.`);
  const def = artifactTypes.journey.content.parse(v.content);
  const cg = def.controlGroup;
  if (!cg)
    throw new AppError('invalid_input', 'This journey has no control group. Set controlGroup {percent} and publish it to measure uplift.');

  const hashVersion = holdoutHashVersion(cg.percent);
  const from = range.from ? new Date(range.from) : undefined;
  const to = range.to ? new Date(range.to) : undefined;
  // Snapshot the outbox before the ClickHouse reads: an event that is still queued at this point is
  // not in what follows, and one published afterwards must not make this report look complete.
  const publication = await outboxPublicationBarrier(deps.tx, deps.workspaceId, journeyId);
  const publicationIncomplete = publication.outstanding > 0 || publication.failed > 0;
  // The same merge-family resolution and window the campaign report uses (#985, #1070): one
  // person, one arm, the earliest assignment decides, and the window applies to that winner rather
  // than to every row. A later copy an entry wrote onto the survivor must not count the person
  // twice, and an alias's row must not decide an arm whose earliest assignment is outside the
  // window. The winners live in a transaction-scoped table, so they are read in bounded pages.
  const winners = await holdoutWinners(deps.tx, deps.workspaceId, { type: 'journey', id: journeyId }, hashVersion, {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const counts = {
    control: { entered: winners.control, converted: 0, unsubscribed: 0 },
    treatment: { entered: winners.treatment, converted: 0, unsubscribed: 0 },
  };
  // The same k rule as the campaign summary (#590): an arm below k is never reported, so the
  // journey's own report and MCP cannot expose a handful of people the summary already hides.
  if (holdoutBelowK(counts)) {
    return {
      journeyId,
      controlGroup: { percent: cg.percent, minSampleSize: cg.minSampleSize, hashVersion },
      from: range.from ?? null,
      to: range.to ?? null,
      k: K,
      ...suppressHoldout(`Suppressed: fewer than k=${K} people in the control or treatment arm, so counts, rates and lift are hidden.`),
    };
  }
  // Outcomes come from ClickHouse (the journey's goal events and the e-mail unsubscribe
  // guardrail), joined in code to the Postgres winners. The event store applies the row policies
  // through settingsFor, so a query never crosses workspaces. An outcome recorded before a merge
  // still carries the alias id, so each page of winners reads its own merge family and resolves the
  // outcome through that page's map before matching it to a winner (#1096). Reading per page keeps
  // memory and the ClickHouse read at a page, not the journey's whole outcome history.
  const pageProfileLimit = deps.pageProfileLimit ?? JOURNEY_HOLDOUT_PAGE_PROFILE_LIMIT;
  const unresolved = new Set<PageUnresolved>();
  for (let after: string | undefined; ; ) {
    const page = await winners.page(after, journeyHoldoutPageSize);
    if (!page.length) break;
    const people = new Set(page.map((winner) => winner.person));
    const scope = await pageOutcomeScope(deps.tx, deps.workspaceId, [...people], pageProfileLimit);
    if (scope.unresolved) unresolved.add(scope.unresolved);
    const outcomes = await deps.events.journeyHoldoutOutcomes(deps.workspaceId, {
      journeyId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      profileIds: scope.profileIds,
    });
    // An outcome id belongs to the person whose component this page read; over the guard the page
    // is read by stored profile id only, so an alias outcome is not counted for it.
    const personOf = (id: string) => scope.byProfile.get(id) ?? (people.has(id) ? id : undefined);
    const converted = new Set<string>();
    for (const id of outcomes.converted) {
      const person = personOf(id);
      if (person) converted.add(person);
    }
    const unsubscribed = new Set<string>();
    for (const id of outcomes.unsubscribed) {
      const person = personOf(id);
      if (person) unsubscribed.add(person);
    }
    for (const winner of page) {
      if (converted.has(winner.person)) counts[winner.arm].converted++;
      if (unsubscribed.has(winner.person)) counts[winner.arm].unsubscribed++;
    }
    if (page.length < journeyHoldoutPageSize) break;
    after = page[page.length - 1]!.person;
  }
  const analysis = analyseHoldout(counts.control, counts.treatment, cg.minSampleSize);
  const verdictNote = publicationIncomplete
    ? incompletePublicationNote(publication, 'no verdict is issued')
    : analysis.verdict === 'not_enough_data'
      ? `Need at least ${cg.minSampleSize} people in each arm; ${counts.control.entered} control and ${counts.treatment.entered} treatment so far.`
      : analysis.verdict === 'no_clear_difference'
        ? 'The 95% interval for the difference includes zero, so the journey has not shown a clear effect yet.'
        : analysis.verdict === 'treatment_better'
          ? 'Treatment converted at a higher rate and the 95% interval excludes zero; the journey looks incremental.'
          : 'Treatment converted at a lower rate and the 95% interval excludes zero; the journey looks harmful.';
  const note =
    unresolved.size === 0
      ? verdictNote
      : `${verdictNote} ${[...unresolved].map((reason) => unresolvedOutcomeNote(reason, pageProfileLimit)).join(' ')}`;
  return {
    journeyId,
    controlGroup: { percent: cg.percent, minSampleSize: cg.minSampleSize, hashVersion },
    from: range.from ?? null,
    to: range.to ?? null,
    k: K,
    ...analysis,
    // A pending or failed journey event can still change the outcome counts. Counts and rates are
    // reported, but the actionable comparison is withheld until publication is complete.
    ...(publicationIncomplete ? { absoluteLift: null, relativeLift: null, ci95: null, verdict: 'not_enough_data' as const } : {}),
    note,
    suppressed: false,
  };
}
