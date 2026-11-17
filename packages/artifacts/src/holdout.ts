import { createHash, randomBytes } from 'node:crypto';
import { schema, type Tx } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';
import { mergeComponentCtes } from './mergeComponent';

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
 * Maps each profile id to the person it belongs to today: the representative of its merge component
 * (#944, #985). The representative is the end of the `merged_into` chain, or the lowest id on a
 * corrupted cycle; see {@link mergeComponentCtes} for the one definition the send path, the report
 * and the campaign identity map share. Used where a decision must be made once per person even
 * though a row can sit on an id the person was merged away from.
 *
 * The ids travel as one array parameter, not one per id: a large campaign's set is far past
 * PostgreSQL's 65,535-parameter limit, and `holdoutResult` would fail even without a single merge.
 */
export async function canonicalPeople(tx: Tx, workspaceId: string, profileIds: readonly string[]): Promise<Map<string, string>> {
  const canonical = new Map<string, string>();
  const ids = [...new Set(profileIds)];
  if (!ids.length) return canonical;
  const res = await tx.execute<{ origin: string; representative: string }>(sql`
    WITH RECURSIVE ${mergeComponentCtes(workspaceId, {
      seeds: sql`SELECT DISTINCT seed.id FROM unnest(${sql.param(ids)}::text[]) AS seed(id)`,
    })}
    SELECT origin, representative FROM merge_representative`);
  for (const row of res.rows) canonical.set(row.origin, row.representative);
  for (const id of ids) if (!canonical.has(id)) canonical.set(id, id);
  return canonical;
}

interface StoredArm {
  profileId: string;
  arm: HoldoutArm;
  assignedAt: Date;
}

/**
 * The arm this person already holds in one scope version (#944): their own row, or one written
 * under a profile that was merged into them. A merge moves assignments to the survivor (migration
 * 0041), but a run that selected a stale alias after a merge wrote its row on the alias — that row
 * is still this person's arm, and the earliest one wins when two disagree, so an arm is never
 * replaced by a later one. The walk reads the whole merge component of the id's representative
 * (#985), the same component the report groups assignments by, so a long chain or a cycle cannot
 * hide an arm from one path and show it to the other.
 */
async function oldestArm(
  tx: Tx,
  workspaceId: string,
  scope: HoldoutScope,
  hashVersion: string,
  profileId: string,
): Promise<{ person: string; arm: StoredArm | null }> {
  const res = await tx.execute<{ person: string; profile_id: string | null; arm: HoldoutArm | null; assigned_at: Date | null }>(sql`
    WITH RECURSIVE ${mergeComponentCtes(workspaceId, {
      seeds: sql`SELECT ${profileId}::text AS id`,
      componentOf: sql`SELECT representative AS rep FROM merge_representative WHERE origin = ${profileId}`,
    })},
    person AS (SELECT representative AS id FROM merge_representative WHERE origin = ${profileId})
    SELECT person.id AS person, a.profile_id, a.arm, a.assigned_at
    FROM person
    LEFT JOIN merge_component mc ON TRUE
    LEFT JOIN holdout_assignments a
      ON a.workspace_id = ${workspaceId} AND a.scope_type = ${scope.type} AND a.scope_id = ${scope.id}
     AND a.hash_version = ${hashVersion} AND a.profile_id = mc.profile_id
    -- The shared order (also used by holdoutWinners and campaigns.holdoutResult): earliest decision
    -- to the microsecond, then the lower profile id in code-unit order.
    ORDER BY a.assigned_at, a.profile_id COLLATE "C"
    LIMIT 1`);
  const row = res.rows[0]!;
  return {
    person: row.person,
    arm:
      row.profile_id !== null && row.arm !== null && row.assigned_at !== null
        ? { profileId: row.profile_id, arm: row.arm, assignedAt: new Date(row.assigned_at) }
        : null,
  };
}

/** One person's winning assignment, as a report reads it. */
export interface HoldoutWinner {
  person: string;
  arm: HoldoutArm;
  assignedAt: Date;
}

/**
 * The winning assignments of one scope version, materialised in the transaction and readable in
 * bounded pages. `control`, `treatment`, `first` and `last` are the SQL aggregates over the same
 * winners after the report window, so a caller never holds the campaign's whole history in memory.
 */
export interface HoldoutWinnerSet {
  control: number;
  treatment: number;
  /** The earliest winning assignment in the window; null when no winner falls inside it. */
  first: Date | null;
  /** The latest winning assignment in the window; null when no winner falls inside it. */
  last: Date | null;
  /**
   * The next page of winners ordered by person id, after `after` (exclusive). Keep passing the last
   * person of each page until a short page comes back. Reads are per transaction: the temporary
   * table is dropped when it commits.
   */
  page(after: string | undefined, limit: number): Promise<HoldoutWinner[]>;
}

/**
 * Chooses each person's winning assignment in PostgreSQL (#972). Each assignment's profile is
 * resolved to the representative of its merge component (#985, `mergeComponentCtes`), the same
 * representative `oldestArm` and `canonicalPeople` resolve, then `DISTINCT ON (person)` takes the
 * earliest `assigned_at` and, on a tie, the lower profile id — the order `oldestArm` uses for the
 * send and `assignHoldout` reads: `assigned_at, profile_id COLLATE "C"`. Keep the two in step;
 * `merge-component-parity.test.ts` asserts the SQL winner and the send path agree on long chains and
 * cycles, and `holdout-winners.test.ts` on ties and sub-millisecond differences.
 *
 * The requested window is applied to the winners, never to their input: an alias row inside the
 * window must not decide an arm whose earliest assignment is outside it (#944). The winners land in
 * a transaction-scoped temporary table, so one query chooses them, the aggregates stay in SQL and
 * the report pages the people it still needs instead of loading the whole campaign (#972).
 */
export async function holdoutWinners(
  tx: Tx,
  workspaceId: string,
  scope: HoldoutScope,
  hashVersion: string,
  window: { from?: Date; to?: Date } = {},
): Promise<HoldoutWinnerSet> {
  const table = `holdout_winners_${randomBytes(6).toString('hex')}`;
  const temp = sql.raw(table);
  await tx.execute(sql`
    CREATE TEMP TABLE ${temp} (
      person text COLLATE "C" PRIMARY KEY,
      arm text NOT NULL,
      assigned_at timestamptz NOT NULL
    ) ON COMMIT DROP`);
  await tx.execute(sql`
    WITH RECURSIVE scoped AS (
      SELECT a.profile_id, a.arm, a.assigned_at
      FROM holdout_assignments a
      WHERE a.workspace_id = ${workspaceId} AND a.scope_type = ${scope.type}
        AND a.scope_id = ${scope.id} AND a.hash_version = ${hashVersion}
    ), ${mergeComponentCtes(workspaceId, {
      seeds: sql`SELECT DISTINCT s.profile_id FROM scoped s`,
    })},
    winner AS (
      SELECT DISTINCT ON (mr.representative COLLATE "C")
        mr.representative AS person_id, s.arm, s.assigned_at, s.profile_id
      FROM scoped s
      JOIN merge_representative mr ON mr.origin = s.profile_id
      -- The send's order (oldestArm): earliest to the microsecond, then the lower profile id.
      ORDER BY mr.representative COLLATE "C", s.assigned_at, s.profile_id COLLATE "C"
    )
    INSERT INTO ${temp} (person, arm, assigned_at)
    SELECT person_id, arm, assigned_at FROM winner`);
  const summary = await tx.execute<{ arm: HoldoutArm; entered: number; first_micros: string | null; last_micros: string | null }>(sql`
    SELECT arm, count(*)::int AS entered,
      (extract(epoch from min(assigned_at)) * 1000000)::bigint::text AS first_micros,
      (extract(epoch from max(assigned_at)) * 1000000)::bigint::text AS last_micros
    FROM ${temp}
    WHERE (${window.from ?? null}::timestamptz IS NULL OR assigned_at >= ${window.from ?? null})
      AND (${window.to ?? null}::timestamptz IS NULL OR assigned_at <= ${window.to ?? null})
    GROUP BY arm`);
  let control = 0;
  let treatment = 0;
  let first: Date | null = null;
  let last: Date | null = null;
  for (const row of summary.rows) {
    if (row.arm === 'control') control = row.entered;
    else treatment = row.entered;
    // Microseconds in SQL, milliseconds for the JS comparison (a Date keeps only milliseconds).
    const rowFirst = row.first_micros === null ? null : new Date(Number(BigInt(row.first_micros) / 1000n));
    const rowLast = row.last_micros === null ? null : new Date(Number(BigInt(row.last_micros) / 1000n));
    if (rowFirst && (!first || rowFirst < first)) first = rowFirst;
    if (rowLast && (!last || rowLast > last)) last = rowLast;
  }
  return {
    control,
    treatment,
    first,
    last,
    async page(after, limit) {
      const size = Math.max(1, Math.trunc(limit));
      const res = await tx.execute<{ person: string; arm: HoldoutArm; assigned_micros: string }>(sql`
        SELECT person, arm, (extract(epoch from assigned_at) * 1000000)::bigint::text AS assigned_micros
        FROM ${temp}
        WHERE (${window.from ?? null}::timestamptz IS NULL OR assigned_at >= ${window.from ?? null})
          AND (${window.to ?? null}::timestamptz IS NULL OR assigned_at <= ${window.to ?? null})
          ${after === undefined ? sql`` : sql`AND person > ${after}`}
        ORDER BY person
        LIMIT ${size}`);
      return res.rows.map((row) => ({
        person: row.person,
        arm: row.arm,
        assignedAt: new Date(Number(BigInt(row.assigned_micros) / 1000n)),
      }));
    },
  };
}

/**
 * Records the person's arm once per scope version and returns the stored one. Re-entry and a
 * second trigger read the first row, so the arm never changes while the percentage is the same.
 * An arm already held under a profile this person was merged from is theirs, so it is reused and
 * recorded under the person as well — never replaced by a freshly hashed one.
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
  const found = await oldestArm(tx, workspaceId, scope, hashVersion, profileId);
  const existing = found.arm;
  if (existing) {
    if (existing.profileId !== found.person)
      // Same arm, original time: reporting's earliest-wins rule and any later read are unchanged.
      // A row the person already has is never overwritten (the app role may only insert).
      await tx
        .insert(schema.holdoutAssignments)
        .values({
          workspaceId,
          scopeType: scope.type,
          scopeId: scope.id,
          hashVersion,
          profileId: found.person,
          arm: existing.arm,
          assignedAt: existing.assignedAt,
        })
        .onConflictDoNothing();
    return { assignment: { arm: existing.arm, hashVersion, percent: config.percent }, created: false };
  }
  const arm = armFor(config.percent, workspaceId, scope.id, hashVersion, profileId);
  const [inserted] = await tx
    .insert(schema.holdoutAssignments)
    .values({ workspaceId, scopeType: scope.type, scopeId: scope.id, hashVersion, profileId, arm })
    .onConflictDoNothing()
    .returning({ arm: schema.holdoutAssignments.arm });
  if (inserted) return { assignment: { arm: inserted.arm, hashVersion, percent: config.percent }, created: true };
  // A concurrent caller recorded first: answer with the stored arm (never a second decision).
  const stored = await oldestArm(tx, workspaceId, scope, hashVersion, profileId);
  return { assignment: { arm: stored.arm?.arm ?? arm, hashVersion, percent: config.percent }, created: false };
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
  /**
   * False when the contributor cannot contribute to this total at all (its value is zero by
   * construction, e.g. an SMS-only member in an e-mail total). Such a hidden contributor does not
   * protect the total, because everyone knows its share is zero. An observed zero still applies:
   * "none of these people converted" is itself a small-group disclosure. Defaults to true.
   */
  applies?: boolean;
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
  // Only a hidden contributor that can contribute to this total protects it (0.14.19 review round 2).
  let hidden = 0;
  for (const contributor of contributors) if (contributor.hidden && contributor.applies !== false) hidden += 1;
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
