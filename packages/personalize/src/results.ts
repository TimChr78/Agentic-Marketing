import { artifactTypes } from '@agentic-marketing/artifacts';
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
    'Exposures, conversions (the goal event after first exposure) and conversion rates per variant of a web experience, compared with the control (holdout, or else the first variant): lift, fixed-horizon p-value and 95% interval, an always-valid sequential p-value, and Bayesian probabilities to beat the control and to be best. `recommendation` follows the experience’s analysis method.',
  input: z.object({ artifactId: z.string().regex(/^exp_[0-9a-f]{32}$/), days: z.number().int().min(1).max(400).optional() }),
  output: z.object({
    goal: z.string().nullable(),
    control: z.string().nullable(),
    variants: z.array(
      z.object({
        variant: z.string(),
        exposed: z.number(),
        converted: z.number(),
        rate: z.number(),
        lift: z.number().nullable(),
        pValue: z.number().nullable(),
        ci95: z.tuple([z.number(), z.number()]).nullable(),
        sequentialP: z.number().nullable().describe('Always-valid p-value: may be checked at any time'),
        probBeatControl: z.number().nullable(),
        probBest: z.number(),
        expectedLoss: z.number().describe('Expected conversion-rate points lost by choosing this variant'),
      }),
    ),
    method: z.enum(['sequential', 'bayesian', 'fixed']),
    recommendation: z.string(),
    note: z.string(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const [row] = await ctx.tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
        ),
      )
      .where(eq(schema.artifacts.id, input.artifactId));
    if (!row) throw new AppError('not_found', `No experience ${input.artifactId}.`);
    const def = artifactTypes.experience.content.parse(row.content);
    const counts = await ctx.services.events.experimentCounts(ctx.principal.workspaceId, {
      experienceId: input.artifactId,
      goal: def.goal?.event,
      since: input.days ? new Date(Date.now() - input.days * 86_400_000) : undefined,
    });
    const controlRow = counts.find((c) => c.variant === 'holdout') ?? counts.find((c) => c.variant === def.variants[0]?.id) ?? null;
    const bayes = bayesian(counts, controlRow?.variant ?? null);
    const variants = counts.map((c) => {
      const vs = controlRow && c.variant !== controlRow.variant;
      return {
        ...c,
        rate: c.exposed ? c.converted / c.exposed : 0,
        ...(vs ? compare(controlRow, c) : { lift: null, pValue: null, ci95: null }),
        sequentialP: vs ? sequentialP(controlRow, c) : null,
        ...(bayes.get(c.variant) ?? { probBeatControl: null, probBest: 0, expectedLoss: 0 }),
      };
    });
    const { method, alpha, threshold } = def.analysis;
    const challengers = variants.filter((v) => controlRow && v.variant !== controlRow.variant);
    const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
    let recommendation = 'Keep the experiment running.';
    if (!def.goal) recommendation = 'Set a goal event to measure conversions.';
    else if (!controlRow || !challengers.length) recommendation = 'Nothing to compare yet.';
    else if (method === 'sequential') {
      const win = challengers.filter((v) => v.sequentialP !== null && v.sequentialP < alpha).sort((a, b) => b.rate - a.rate)[0];
      if (win)
        recommendation =
          win.rate > controlRow.converted / Math.max(controlRow.exposed, 1)
            ? `${win.variant} beats ${controlRow.variant} (always-valid p = ${win.sequentialP!.toFixed(4)}); you can stop and ship it.`
            : `${win.variant} does worse than ${controlRow.variant} (always-valid p = ${win.sequentialP!.toFixed(4)}); you can stop it.`;
    } else if (method === 'bayesian') {
      const win = [...challengers].sort((a, b) => (b.probBeatControl ?? 0) - (a.probBeatControl ?? 0))[0];
      if ((win.probBeatControl ?? 0) >= threshold)
        recommendation = `${win.variant} beats ${controlRow.variant} with ${pct(win.probBeatControl ?? 0)} probability (expected loss ${pct(win.expectedLoss)}).`;
      else if (challengers.every((v) => (v.probBeatControl ?? 1) <= 1 - threshold))
        recommendation = `${controlRow.variant} is better than every variant with at least ${pct(threshold)} probability.`;
    } else recommendation = 'Fixed horizon: read the p-values once the planned sample size is reached, not before.';
    return {
      goal: def.goal?.event ?? null,
      control: controlRow?.variant ?? null,
      variants,
      method,
      recommendation,
      note: def.goal
        ? 'Sequential p-values may be checked at any time; the fixed-horizon p-value only at the planned sample size; Bayesian figures assume a uniform prior.'
        : 'Set a goal event on the experience to measure conversions.',
    };
  },
});

export const experienceCommands = [experienceResults] as const;
