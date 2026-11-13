import { createHash } from 'node:crypto';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';

// Holdout groups (#67): a deterministic share of a scope's entrants is held back from marketing
// messages while still being measured. Assignment is a pure function of workspace, scope id,
// hash version and profile id, so it is stable across re-entries, restarts and servers; the
// database only records which arm the function chose. Journeys and campaigns share this module,
// with one scope each: a journey can use its own, a campaign's covers every sending member.

export type HoldoutArm = 'control' | 'treatment';

/** The thing a control group measures: one journey, or a whole campaign. */
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

/** The detail stored on a `holdout_assigned` event; the campaign id names the outer scope. */
export function holdoutDetail(assignment: HoldoutAssignment, campaignId?: string): string {
  return `${campaignId ? `campaignId=${campaignId} ` : ''}arm=${assignment.arm} percent=${assignment.percent} hash=${assignment.hashVersion}`;
}

/**
 * A stable numeric id for a person's campaign assignment event. Broadcasts have no journey
 * participant to reuse, and journey events are keyed by participant, so this keeps each person's
 * assignment a separate row.
 */
export function holdoutParticipantId(profileId: string): number {
  const digest = createHash('sha256').update(profileId).digest();
  return digest.readUInt32BE(0) * 2 ** 16 + (digest.readUInt16BE(4) >> 0);
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

/**
 * The k-anonymity floor for every read surface: a group smaller than this is never reported. It
 * lives here because the holdout statistics are shared by campaigns and journeys, and both must
 * apply the same floor (#586, #590).
 */
export const K = 5;

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

/** True when an arm holds fewer people than k, so the whole comparison must be hidden. */
export function holdoutBelowK(analysis: { control: { entered: number }; treatment: { entered: number } }, k = K): boolean {
  return analysis.control.entered < k || analysis.treatment.entered < k;
}

/** True when any split arm holds fewer people than k, so small-arm counts and every comparison are hidden. */
export function anyArmBelowK(arms: readonly { entered: number }[], k = K): boolean {
  return arms.some((arm) => arm.entered < k);
}

/** How one row of a dimensioned result stands against the k floor. */
export interface SuppressionCandidate {
  /** The row's group size: the same measure the k test uses (distinct people, or members). */
  group: number;
  /** True when the row is already hidden because its group is below k. */
  hidden: boolean;
}

/**
 * One contributor to a total. Contributors are the rows grouped by their independent population
 * (the campaign or member), not the physical currency row: a campaign that converts in two
 * currencies is one population, and hiding its two currency rows is not two hidden groups.
 */
export interface TotalContributor {
  /** Opaque identity used by the caller to apply the decision. */
  id: number | string;
  /** The contributor's independent population; the deterministic tie-break for equal values. */
  group: number;
  /** The contributor's value in this total. A zero cannot be a complement: hiding it hides nothing. */
  value: number;
  /** True when this contributor's value in this total is already suppressed. */
  hidden: boolean;
}

/** What one total needs so a single hidden contributor cannot be recovered by subtraction. */
export interface ComplementaryTotalDecision {
  /** Contributors to hide for this total. Empty unless exactly one was hidden. */
  hide: (number | string)[];
  /** True when there is no visible non-zero contributor, so the total itself must be withheld. */
  withheld: boolean;
}

/**
 * Complementary suppression for one total (#692, option B). When exactly one contributor is hidden,
 * a reader recovers it as the total minus the visible contributors. Hide the smallest visible
 * contributor with a non-zero value in this total, so only a sum of hidden values is derivable.
 * Ties go to the first contributor, the result's deterministic order.
 *
 * When the only visible contributors are zero, hiding one would change nothing and the hidden
 * value would stay recoverable. The total is withheld instead; that is the narrow option-A
 * fallback, used only when no visible non-zero contributor exists.
 */
export function complementaryTotal(contributors: readonly TotalContributor[]): ComplementaryTotalDecision {
  let hidden = 0;
  for (const contributor of contributors) if (contributor.hidden) hidden += 1;
  if (hidden !== 1) return { hide: [], withheld: false };
  let pick: TotalContributor | undefined;
  for (const contributor of contributors) {
    if (contributor.hidden || !(contributor.value > 0)) continue;
    if (!pick || contributor.value < pick.value) pick = contributor;
  }
  return pick ? { hide: [pick.id], withheld: false } : { hide: [], withheld: true };
}

/**
 * Applies {@link complementaryTotal} to every total a response exposes beside its rows, until no
 * total has exactly one hidden contributor. Hiding a complement in one total can make the same
 * contributor hidden in another, so the pass repeats; `contributors` is re-derived each time.
 *
 * Termination: hiding and withholding are monotone. A pass that changes something either hides at
 * least one contributor (a finite set) or withholds one total (also finite), so the budget below is
 * an upper bound and the loop cannot spin.
 */
export function planComplementarySuppression(opts: {
  totals: readonly string[];
  contributors: (total: string) => readonly TotalContributor[];
  /** Applies one hide. Returns true only when it hid something that was visible. */
  hide: (total: string, id: number | string) => boolean;
}): { withheld: string[]; hidden: number } {
  const withheld = new Set<string>();
  let hidden = 0;
  let budget = opts.totals.length + 1;
  for (const total of opts.totals) budget += opts.contributors(total).length;
  let changed = true;
  while (changed && budget-- > 0) {
    changed = false;
    for (const total of opts.totals) {
      if (withheld.has(total)) continue;
      const decision = complementaryTotal(opts.contributors(total));
      if (decision.withheld) {
        withheld.add(total);
        changed = true;
        continue;
      }
      for (const id of decision.hide)
        if (opts.hide(total, id)) {
          hidden += 1;
          changed = true;
        }
    }
  }
  return { withheld: [...withheld], hidden };
}

/**
 * Complementary suppression for one flat row list, the segment path. Rows are their own
 * contributors, so this is {@link complementaryTotal} over the group sizes. Returns the index of the
 * row to hide, or null when nothing more is needed: no row is hidden, two or more already are, or
 * every visible row is empty and the caller has no total to withhold.
 *
 * The rule applies when the array is one dimensioned result with a visible total above it. A view
 * with only two arms already withholds both arms and every comparison instead (#590).
 */
export function complementarySuppression(rows: readonly SuppressionCandidate[]): number | null {
  const decision = complementaryTotal(rows.map((row, id) => ({ id, group: row.group, value: row.group, hidden: row.hidden })));
  if (decision.withheld || !decision.hide.length) return null;
  return Number(decision.hide[0]);
}

export interface SuppressedArmResult {
  entered: null;
  converted: null;
  unsubscribed: null;
  conversionRate: null;
  unsubscribeRate: null;
}

export interface SuppressedHoldoutAnalysis {
  control: SuppressedArmResult;
  treatment: SuppressedArmResult;
  absoluteLift: null;
  relativeLift: null;
  ci95: null;
  minSampleSizeMet: false;
  verdict: 'not_enough_data';
  suppressed: true;
  note: string;
}

/**
 * The one suppressed holdout shape, shared by the journey command, the campaign summary and the
 * campaign-wide holdout. No count, rate or lift survives, and the verdict says there is not enough
 * data, so a caller can never render the hidden arms as zero (#590).
 */
export function suppressHoldout(note: string): SuppressedHoldoutAnalysis {
  const arm: SuppressedArmResult = {
    entered: null,
    converted: null,
    unsubscribed: null,
    conversionRate: null,
    unsubscribeRate: null,
  };
  return {
    control: { ...arm },
    treatment: { ...arm },
    absoluteLift: null,
    relativeLift: null,
    ci95: null,
    minSampleSizeMet: false,
    verdict: 'not_enough_data',
    suppressed: true,
    note,
  };
}
