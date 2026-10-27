import { type ArmResult, analyseHoldout, artifactTypes, type HoldoutVerdict, holdoutHashVersion } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { and, eq, gte, lte } from 'drizzle-orm';

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
  control: ArmResult;
  treatment: ArmResult;
  absoluteLift: number;
  relativeLift: number | null;
  ci95: [number, number] | null;
  minSampleSizeMet: boolean;
  verdict: HoldoutVerdict;
  note: string;
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
  const assignments = await deps.tx
    .select({ profileId: schema.holdoutAssignments.profileId, arm: schema.holdoutAssignments.arm })
    .from(schema.holdoutAssignments)
    .where(
      and(
        eq(schema.holdoutAssignments.workspaceId, deps.workspaceId),
        eq(schema.holdoutAssignments.scopeType, 'journey'),
        eq(schema.holdoutAssignments.scopeId, journeyId),
        eq(schema.holdoutAssignments.hashVersion, hashVersion),
        from ? gte(schema.holdoutAssignments.assignedAt, from) : undefined,
        to ? lte(schema.holdoutAssignments.assignedAt, to) : undefined,
      ),
    );
  const counts = {
    control: { entered: 0, converted: 0, unsubscribed: 0 },
    treatment: { entered: 0, converted: 0, unsubscribed: 0 },
  };
  const people = { control: new Set<string>(), treatment: new Set<string>() };
  for (const row of assignments) {
    counts[row.arm].entered++;
    people[row.arm].add(row.profileId);
  }
  // Outcomes come from ClickHouse (the journey's goal events and the e-mail unsubscribe
  // guardrail), joined in code to the Postgres assignments. The event store applies the row
  // policies through settingsFor, so a query never crosses workspaces.
  const outcomes = await deps.events.journeyHoldoutOutcomes(deps.workspaceId, {
    journeyId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const converted = new Set(outcomes.converted);
  const unsubscribed = new Set(outcomes.unsubscribed);
  for (const arm of ['control', 'treatment'] as const) {
    for (const profileId of people[arm]) {
      if (converted.has(profileId)) counts[arm].converted++;
      if (unsubscribed.has(profileId)) counts[arm].unsubscribed++;
    }
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
    ...analysis,
    note,
  };
}
