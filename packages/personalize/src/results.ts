import { anyArmBelowK, artifactTypes, K } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

// Experiment results: per variant, visitors exposed and converted (the goal event after their
// first exposure), compared with the control (the holdout, or else the first variant) three ways:
// - fixed horizon: a two-proportion z-test, valid only at a sample size chosen up front;
// - sequential: an always-valid p-value (mixture SPRT, as in Johari et al. 2017), which may be
//   checked as often as you like and acted on as soon as it falls below alpha;
// - Bayesian: Beta(1, 1) priors, the probability that each variant beats the control and is the
//   best, and the expected loss of choosing it (in conversion-rate points).
// The experience's `analysis.method` decides which one the recommendation follows.

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
function phi(x: number) {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function compare(control: { exposed: number; converted: number }, v: { exposed: number; converted: number }) {
  const p1 = control.exposed ? control.converted / control.exposed : 0;
  const p2 = v.exposed ? v.converted / v.exposed : 0;
  if (!control.exposed || !v.exposed) return { lift: null, pValue: null, ci95: null };
  const pooled = (control.converted + v.converted) / (control.exposed + v.exposed);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.exposed + 1 / v.exposed));
  const z = se ? (p2 - p1) / se : 0;
  const seDiff = Math.sqrt((p1 * (1 - p1)) / control.exposed + (p2 * (1 - p2)) / v.exposed);
  return {
    lift: p1 ? (p2 - p1) / p1 : null,
    pValue: se ? 2 * (1 - phi(Math.abs(z))) : 1,
    ci95: [p2 - p1 - 1.96 * seDiff, p2 - p1 + 1.96 * seDiff] as [number, number],
  };
}

/**
 * Always-valid p-value of the difference in conversion rates (normal approximation, mixing
 * variance tau² over the effect). Conservative: the running minimum over earlier looks would be
 * at most this.
 */
export function sequentialP(control: { exposed: number; converted: number }, v: { exposed: number; converted: number }, tau2 = 1e-4) {
  if (!control.exposed || !v.exposed) return null;
  const p1 = control.converted / control.exposed;
  const p2 = v.converted / v.exposed;
  // A floor on the variance keeps 0% or 100% rates from dividing by zero.
  const variance = Math.max((p1 * (1 - p1)) / control.exposed + (p2 * (1 - p2)) / v.exposed, 1e-9);
  const d = p2 - p1;
  const lambda = Math.sqrt(variance / (variance + tau2)) * Math.exp((tau2 * d * d) / (2 * variance * (variance + tau2)));
  return Math.min(1, 1 / lambda);
}

/** A seeded generator (mulberry32), so the same counts always give the same Bayesian figures. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Gamma(shape, 1) by Marsaglia and Tsang; shapes below 1 are boosted. */
function gamma(shape: number, rand: () => number): number {
  if (shape < 1) return gamma(shape + 1, rand) * rand() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller normal draw.
      x = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Probability of beating the control, of being the best, and the expected loss, per variant. */
export function bayesian(rows: { variant: string; exposed: number; converted: number }[], control: string | null, draws = 20_000) {
  const rand = rng(rows.reduce((a, r) => (a * 31 + r.exposed * 7 + r.converted) >>> 0, 17));
  const beatControl = new Map(rows.map((r) => [r.variant, 0]));
  const best = new Map(rows.map((r) => [r.variant, 0]));
  const loss = new Map(rows.map((r) => [r.variant, 0]));
  for (let i = 0; i < draws; i++) {
    const sample = rows.map((r) => {
      const a = gamma(1 + r.converted, rand);
      const b = gamma(1 + r.exposed - r.converted, rand);
      return a / (a + b);
    });
    const top = Math.max(...sample);
    const ctrl = control ? sample[rows.findIndex((r) => r.variant === control)] : undefined;
    rows.forEach((r, j) => {
      if (ctrl !== undefined && sample[j] > ctrl) beatControl.set(r.variant, (beatControl.get(r.variant) ?? 0) + 1);
      if (sample[j] === top) best.set(r.variant, (best.get(r.variant) ?? 0) + 1);
      loss.set(r.variant, (loss.get(r.variant) ?? 0) + (top - sample[j]));
    });
  }
  return new Map(
    rows.map((r) => [
      r.variant,
      {
        probBeatControl: control && r.variant !== control ? (beatControl.get(r.variant) ?? 0) / draws : null,
        probBest: (best.get(r.variant) ?? 0) / draws,
        expectedLoss: (loss.get(r.variant) ?? 0) / draws,
      },
    ]),
  );
}

export const experienceResults = defineCommand({
  name: 'experiences.results',
  title: 'Experiment results',
  description:
    'Exposures, conversions (the goal event after first exposure) and conversion rates per variant of a web experience, compared with the control (holdout, or else the first variant): lift, fixed-horizon p-value and 95% interval, an always-valid sequential p-value, and Bayesian probabilities to beat the control and to be best. `recommendation` follows the experience’s analysis method. A variant with fewer than k=5 exposed visitors has every count, rate and comparison null and `suppressed` true; `k` and the top-level `suppressed` say which floor applied, and a comparison or verdict that needs a suppressed variant is withheld.',
  input: z.object({ artifactId: z.string().regex(/^exp_[0-9a-f]{32}$/), days: z.number().int().min(1).max(400).optional() }),
  output: z.object({
    version: z
      .number()
      .int()
      .describe('The experience version these results describe: the published one, or the latest while it has never been published'),
    goal: z.string().nullable(),
    control: z.string().nullable(),
    k: z.number().int().describe('The k-anonymity floor; a variant below it is suppressed'),
    suppressed: z
      .boolean()
      .describe('True when a variant held fewer than k exposed visitors, so its counts and every comparison that needs it are hidden'),
    variants: z.array(
      z.object({
        variant: z.string(),
        suppressed: z
          .boolean()
          .describe('True when this variant held fewer than k exposed visitors, so its counts, rates and comparisons are hidden'),
        exposed: z.number().int().nullable().describe('Visitors exposed to this variant; null when the variant is suppressed'),
        converted: z.number().int().nullable().describe('Visitors who converted after exposure; null when the variant is suppressed'),
        rate: z.number().nullable().describe('Converted divided by exposed; null when the variant is suppressed'),
        lift: z.number().nullable(),
        pValue: z.number().nullable(),
        ci95: z.tuple([z.number(), z.number()]).nullable(),
        sequentialP: z.number().nullable().describe('Always-valid p-value: may be checked at any time'),
        probBeatControl: z.number().nullable(),
        probBest: z.number().nullable().describe('Null when any variant is suppressed, because the best needs every arm'),
        expectedLoss: z
          .number()
          .nullable()
          .describe('Expected conversion-rate points lost by choosing this variant; null when any variant is suppressed'),
      }),
    ),
    method: z.enum(['sequential', 'bayesian', 'fixed']),
    analysis: z
      .object({
        method: z.enum(['sequential', 'bayesian', 'fixed']),
        alpha: z.number(),
        threshold: z.number(),
      })
      .describe('The analysis settings of the version these results describe; an open draft may configure different ones'),
    recommendation: z.string(),
    note: z.string(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const [artifact] = await ctx.tx
      .select({ latestVersion: schema.artifacts.latestVersion, publishedVersion: schema.artifacts.publishedVersion })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, input.artifactId)));
    if (!artifact) throw new AppError('not_found', `No experience ${input.artifactId}.`);
    // Results describe what visitors actually saw. Editing a draft must not rewrite a live
    // experiment's goal, analysis or control fallback (#631); a never-published one keeps using
    // its latest version, as before.
    const version = artifact.publishedVersion ?? artifact.latestVersion;
    const [row] = await ctx.tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
          eq(schema.artifactVersions.artifactId, input.artifactId),
          eq(schema.artifactVersions.number, version),
        ),
      );
    if (!row) throw new AppError('not_found', `No experience ${input.artifactId} version ${version}.`);
    const def = artifactTypes.experience.content.parse(row.content);
    const { variants: counts, unversioned } = await ctx.services.events.experimentCounts(ctx.principal.workspaceId, {
      experienceId: input.artifactId,
      // Variant ids are editable per version, so counting every exposure of the experience would
      // mix ids the published version no longer has into its results (#758).
      version,
      goal: def.goal?.event,
      since: input.days ? new Date(Date.now() - input.days * 86_400_000) : undefined,
    });
    const controlRow = counts.find((c) => c.variant === 'holdout') ?? counts.find((c) => c.variant === def.variants[0]?.id) ?? null;
    // The same k floor the holdout and split reads apply (#828): a variant with fewer than k
    // exposed visitors never reports a count, rate or comparison. The floor is on the exposed
    // group (the people the numbers describe); a suppressed variant's conversions are hidden with
    // it. A comparison that needs a suppressed arm is withheld, and so is any winner verdict.
    const hidden = new Set(counts.filter((c) => c.exposed < K).map((c) => c.variant));
    const belowK = anyArmBelowK(counts.map((c) => ({ entered: c.exposed })));
    const bayes = bayesian(counts, controlRow?.variant ?? null);
    const variants = counts.map((c) => {
      if (hidden.has(c.variant))
        return {
          variant: c.variant,
          suppressed: true,
          exposed: null,
          converted: null,
          rate: null,
          lift: null,
          pValue: null,
          ci95: null,
          sequentialP: null,
          probBeatControl: null,
          probBest: null,
          expectedLoss: null,
        };
      const vs = controlRow && c.variant !== controlRow.variant && !hidden.has(controlRow.variant);
      const stats = bayes.get(c.variant);
      return {
        variant: c.variant,
        suppressed: false,
        exposed: c.exposed,
        converted: c.converted,
        rate: c.exposed ? c.converted / c.exposed : 0,
        ...(vs ? compare(controlRow, c) : { lift: null, pValue: null, ci95: null }),
        sequentialP: vs ? sequentialP(controlRow, c) : null,
        probBeatControl: vs ? (stats?.probBeatControl ?? null) : null,
        // "Best" and its expected loss compare every arm, so one hidden arm withdraws both.
        probBest: belowK ? null : (stats?.probBest ?? 0),
        expectedLoss: belowK ? null : (stats?.expectedLoss ?? 0),
      };
    });
    const { method, alpha, threshold } = def.analysis;
    const challengers = variants.filter((v) => controlRow && v.variant !== controlRow.variant && !v.suppressed);
    const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
    let recommendation = 'Keep the experiment running.';
    if (!def.goal) recommendation = 'Set a goal event to measure conversions.';
    else if (belowK)
      recommendation = `Not enough data to compare: a variant has fewer than k=${K} exposed visitors, so its counts and every comparison that needs it are withheld.`;
    else if (!controlRow || !challengers.length) recommendation = 'Nothing to compare yet.';
    else if (method === 'sequential') {
      const win = challengers
        .filter((v) => v.sequentialP !== null && v.sequentialP < alpha)
        .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
      if (win)
        recommendation =
          (win.rate ?? 0) > controlRow.converted / Math.max(controlRow.exposed, 1)
            ? `${win.variant} beats ${controlRow.variant} (always-valid p = ${win.sequentialP!.toFixed(4)}); you can stop and ship it.`
            : `${win.variant} does worse than ${controlRow.variant} (always-valid p = ${win.sequentialP!.toFixed(4)}); you can stop it.`;
    } else if (method === 'bayesian') {
      const win = [...challengers].sort((a, b) => (b.probBeatControl ?? 0) - (a.probBeatControl ?? 0))[0];
      if ((win.probBeatControl ?? 0) >= threshold)
        recommendation = `${win.variant} beats ${controlRow.variant} with ${pct(win.probBeatControl ?? 0)} probability (expected loss ${pct(win.expectedLoss ?? 0)}).`;
      else if (challengers.every((v) => (v.probBeatControl ?? 1) <= 1 - threshold))
        recommendation = `${controlRow.variant} is better than every variant with at least ${pct(threshold)} probability.`;
    } else recommendation = 'Fixed horizon: read the p-values once the planned sample size is reached, not before.';
    const note = counts.length
      ? def.goal
        ? 'Sequential p-values may be checked at any time; the fixed-horizon p-value only at the planned sample size; Bayesian figures assume a uniform prior.'
        : 'Set a goal event on the experience to measure conversions.'
      : `No data for version ${version} yet: counts include only exposures of version ${version}${input.days ? ` in the last ${input.days} days` : ''}, and no visitor has been exposed to it. Exposures of other versions, and exposures recorded without a version, do not count toward this version.`;
    const suppressedNote = belowK
      ? ` A variant has fewer than k=${K} exposed visitors, so its counts, rates and every comparison that needs it are withheld.`
      : '';
    // Do not drop them silently: when the window holds exposures with no version, say why they
    // were excluded (#758). A count below k is itself a small group, so it is never spelled out.
    const excluded = unversioned
      ? unversioned < K
        ? ` Exposures recorded without a version were excluded, because results count only exposures of version ${version}.`
        : ` ${unversioned} exposure${unversioned === 1 ? '' : 's'} recorded without a version ${unversioned === 1 ? 'was' : 'were'} excluded, because results count only exposures of version ${version}.`
      : '';
    return {
      version,
      goal: def.goal?.event ?? null,
      control: controlRow?.variant ?? null,
      k: K,
      suppressed: belowK,
      variants,
      method,
      analysis: { method, alpha, threshold },
      recommendation,
      note: `${note}${suppressedNote}${excluded}`,
    };
  },
});

import { rolloutCommands } from './rollout';

export const experienceCommands = [experienceResults, ...rolloutCommands] as const;
