import {
  type ArmResult,
  analyseHoldout,
  artifactTypes,
  canonicalPeople,
  type HoldoutVerdict,
  holdoutBelowK,
  holdoutHashVersion,
  holdoutWinners,
  K,
  type SuppressedArmResult,
  suppressHoldout,
} from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { and, eq } from 'drizzle-orm';

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
 * The computation behind journeys.holdoutResult, exported so campaign evaluation can report a
 * journey member's uplift without reimplementing the statistics or the assignment query.
 */
export async function computeJourneyHoldout(
  deps: { tx: Tx; events: EventStore; workspaceId: string },
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
  // still carries the alias id, so resolve the outcome through the same component map as the
  // assignment side before matching it to a winner.
  const outcomes = await deps.events.journeyHoldoutOutcomes(deps.workspaceId, {
    journeyId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const outcomeIds = [...new Set([...outcomes.converted, ...outcomes.unsubscribed])];
  const canonical = await canonicalPeople(deps.tx, deps.workspaceId, outcomeIds);
  const converted = new Set(outcomes.converted.map((id) => canonical.get(id) ?? id));
  const unsubscribed = new Set(outcomes.unsubscribed.map((id) => canonical.get(id) ?? id));
  const PAGE = 1000;
  for (let after: string | undefined; ; ) {
    const page = await winners.page(after, PAGE);
    for (const winner of page) {
      if (converted.has(winner.person)) counts[winner.arm].converted++;
      if (unsubscribed.has(winner.person)) counts[winner.arm].unsubscribed++;
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.person;
  }
  const analysis = analyseHoldout(counts.control, counts.treatment, cg.minSampleSize);
  const note =
    analysis.verdict === 'not_enough_data'
      ? `Need at least ${cg.minSampleSize} people in each arm; ${counts.control.entered} control and ${counts.treatment.entered} treatment so far.`
      : analysis.verdict === 'no_clear_difference'
        ? 'The 95% interval for the difference includes zero, so the journey has not shown a clear effect yet.'
        : analysis.verdict === 'treatment_better'
          ? 'Treatment converted at a higher rate and the 95% interval excludes zero; the journey looks incremental.'
          : 'Treatment converted at a lower rate and the 95% interval excludes zero; the journey looks harmful.';
  return {
    journeyId,
    controlGroup: { percent: cg.percent, minSampleSize: cg.minSampleSize, hashVersion },
    from: range.from ?? null,
    to: range.to ?? null,
    k: K,
    ...analysis,
    note,
    suppressed: false,
  };
}
