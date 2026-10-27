import { createHash } from 'node:crypto';
import { artifactTypes } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { and, eq, gte, lte } from 'drizzle-orm';

// Holdout groups (#67): a deterministic share of a scope's entrants is held back from marketing
// messages while still being measured. Assignment is a pure function of workspace, scope id,
// hash version and profile id, so it is stable across re-entries, restarts and servers; the
// database only records which arm the function chose. Campaigns will reuse the same scope type
// and this module unchanged.

export type HoldoutArm = 'control' | 'treatment';

/** The thing a control group measures. Campaigns will pass their id here later. */
export interface HoldoutScope {
  type: 'journey' | 'campaign';
  id: string;
}

export interface HoldoutConfig {
  percent: number;
  minSampleSize?: number;
  reset?: boolean;
}

export interface HoldoutAssignment {
  arm: HoldoutArm;
  hashVersion: string;
  percent: number;
}

/**
 * The scope version for a percentage. Deliberately covers only the percentage: re-publishing an
 * unrelated edit keeps every assignment, while a changed percentage is a new scope. Publishing a
 * changed percentage after people were assigned is refused unless controlGroup.reset is set.
 */
export function holdoutHashVersion(percent: number): string {
  return `p1-${createHash('sha256').update(`percent:${percent}`).digest('hex').slice(0, 16)}`;
}

/** A bucket in 0–9999; the same inputs always give the same bucket. */
export function holdoutBucket(workspaceId: string, scopeId: string, hashVersion: string, profileId: string): number {
  const digest = createHash('sha256').update(`${workspaceId}:${scopeId}:${hashVersion}:${profileId}`).digest();
  return digest.readUInt32BE(0) % 10_000;
}

/** Control when the bucket is below percent × 100, so the share is the percentage within rounding. */
export function armFor(percent: number, workspaceId: string, scopeId: string, hashVersion: string, profileId: string): HoldoutArm {
  return holdoutBucket(workspaceId, scopeId, hashVersion, profileId) < percent * 100 ? 'control' : 'treatment';
}

/**
 * Records the person's arm once per scope version and returns the stored one. Re-entry and a
 * second trigger read the first row, so the arm never changes while the percentage is the same.
 */
export async function assignHoldout(
  tx: Tx,
  workspaceId: string,
  scope: HoldoutScope,
  config: HoldoutConfig | undefined,
  profileId: string,
): Promise<{ assignment: HoldoutAssignment; created: boolean } | null> {
  if (!config) return null;
  const hashVersion = holdoutHashVersion(config.percent);
  const arm = armFor(config.percent, workspaceId, scope.id, hashVersion, profileId);
  const [inserted] = await tx
    .insert(schema.holdoutAssignments)
    .values({ workspaceId, scopeType: scope.type, scopeId: scope.id, hashVersion, profileId, arm })
    .onConflictDoNothing()
    .returning({ arm: schema.holdoutAssignments.arm });
  const stored =
    inserted?.arm ??
    (
      await tx
        .select({ arm: schema.holdoutAssignments.arm })
        .from(schema.holdoutAssignments)
        .where(
          and(
            eq(schema.holdoutAssignments.workspaceId, workspaceId),
            eq(schema.holdoutAssignments.scopeType, scope.type),
            eq(schema.holdoutAssignments.scopeId, scope.id),
            eq(schema.holdoutAssignments.hashVersion, hashVersion),
            eq(schema.holdoutAssignments.profileId, profileId),
          ),
        )
        .limit(1)
    )[0]?.arm;
  return { assignment: { arm: stored ?? arm, hashVersion, percent: config.percent }, created: !!inserted };
}

export const Z_95 = 1.959963984540054;

/** Wilson score interval for one proportion; null without a sample. */
export function wilsonInterval(converted: number, entered: number, z = Z_95): [number, number] | null {
  if (entered <= 0) return null;
  const p = converted / entered;
  const z2 = z * z;
  const denominator = 1 + z2 / entered;
  const centre = p + z2 / (2 * entered);
  const half = z * Math.sqrt((p * (1 - p)) / entered + z2 / (4 * entered * entered));
  return [(centre - half) / denominator, (centre + half) / denominator];
}

/** Newcombe's hybrid score interval for a difference of proportions (treatment − control). */
export function newcombeDifference(
  control: { converted: number; entered: number },
  treatment: { converted: number; entered: number },
  z = Z_95,
): [number, number] | null {
  if (control.entered <= 0 || treatment.entered <= 0) return null;
  const c = wilsonInterval(control.converted, control.entered, z)!;
  const t = wilsonInterval(treatment.converted, treatment.entered, z)!;
  const p1 = control.converted / control.entered;
  const p2 = treatment.converted / treatment.entered;
  const d = p2 - p1;
  const lower = d - Math.sqrt((p2 - t[0]) ** 2 + (c[1] - p1) ** 2);
  const upper = d + Math.sqrt((t[1] - p2) ** 2 + (p1 - c[0]) ** 2);
  return [Math.max(-1, lower), Math.min(1, upper)];
}

export type HoldoutVerdict = 'not_enough_data' | 'no_clear_difference' | 'treatment_better' | 'treatment_worse';

export interface ArmCounts {
  entered: number;
  converted: number;
  unsubscribed: number;
}

export interface ArmResult extends ArmCounts {
  conversionRate: number;
  unsubscribeRate: number;
}

export interface HoldoutAnalysis {
  control: ArmResult;
  treatment: ArmResult;
  absoluteLift: number;
  relativeLift: number | null;
  ci95: [number, number] | null;
  minSampleSizeMet: boolean;
  verdict: HoldoutVerdict;
}

export function analyseHoldout(control: ArmCounts, treatment: ArmCounts, minSampleSize: number): HoldoutAnalysis {
  const result = (a: ArmCounts): ArmResult => ({
    ...a,
    conversionRate: a.entered ? a.converted / a.entered : 0,
    unsubscribeRate: a.entered ? a.unsubscribed / a.entered : 0,
  });
  const c = result(control);
  const t = result(treatment);
  const absoluteLift = t.conversionRate - c.conversionRate;
  const relativeLift = c.conversionRate ? absoluteLift / c.conversionRate : null;
  const ci95 = newcombeDifference(control, treatment);
  const minSampleSizeMet = control.entered >= minSampleSize && treatment.entered >= minSampleSize;
  // A verdict needs both samples and an interval that excludes zero; a point estimate alone is
  // noise, which is why the "not enough data" state is explicit rather than folded into "no lift".
  let verdict: HoldoutVerdict = 'not_enough_data';
  if (minSampleSizeMet && ci95) {
    if (ci95[0] > 0) verdict = 'treatment_better';
    else if (ci95[1] < 0) verdict = 'treatment_worse';
    else verdict = 'no_clear_difference';
  }
  return { control: c, treatment: t, absoluteLift, relativeLift, ci95, minSampleSizeMet, verdict };
}

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
