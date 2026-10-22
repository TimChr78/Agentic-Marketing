import { artifactTypes } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

// Experiment results: per variant, visitors exposed and converted (the goal event after their
// first exposure), compared with the control (the holdout, or else the first variant) by a
// two-proportion z-test. A fixed-horizon test: decide the sample size up front instead of
// stopping at the first significant peek; sequential testing comes later.

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

export const experienceResults = defineCommand({
  name: 'experiences.results',
  title: 'Experiment results',
  description:
    'Exposures, conversions (the goal event after first exposure) and conversion rates per variant of a web experience, with lift, p-value and 95% interval against the control (holdout, or else the first variant).',
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
      }),
    ),
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
    return {
      goal: def.goal?.event ?? null,
      control: controlRow?.variant ?? null,
      variants: counts.map((c) => ({
        ...c,
        rate: c.exposed ? c.converted / c.exposed : 0,
        ...(controlRow && c.variant !== controlRow.variant ? compare(controlRow, c) : { lift: null, pValue: null, ci95: null }),
      })),
      note: def.goal
        ? 'Fixed-horizon z-test: choose the sample size in advance; stopping at the first p < 0.05 overstates results.'
        : 'Set a goal event on the experience to measure conversions.',
    };
  },
});

export const experienceCommands = [experienceResults] as const;
