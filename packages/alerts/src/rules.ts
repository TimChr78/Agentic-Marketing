import { AppError } from '@agentic-marketing/core';
import type { AlertKind } from '@agentic-marketing/db';
import { z } from 'zod';

// Alert rules are small, typed configurations over the metric layer. The kind decides which
// measure is read and which numbers mean "bad"; the scheduler never accepts SQL from a caller.

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const MIN_WINDOW_MS = HOUR;
export const MAX_WINDOW_MS = 7 * DAY;
export const DEFAULT_WINDOW = 'PT24H';
export const DEFAULT_JOURNEY_WINDOW = 'PT1H';

/**
 * Windows are the ISO-8601 durations the rest of the product already uses in policy text, and
 * the two shapes the alert kinds need: hours and days. A window shorter than an hour is noise,
 * and longer than a week is not an alert any more.
 */
export function windowMs(window: string): number {
  const hours = /^PT([1-9]\d*)H$/.exec(window);
  if (hours) return Number(hours[1]) * HOUR;
  const days = /^P([1-9]\d*)D$/.exec(window);
  if (days) return Number(days[1]) * DAY;
  throw new AppError('invalid_input', `The window "${window}" is not a duration like PT1H or P7D.`);
}

export function windowLabel(window: string): string {
  const ms = windowMs(window);
  if (ms % DAY === 0) {
    const days = ms / DAY;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.round(ms / HOUR);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

const Window = z
  .string()
  .regex(/^(PT[1-9]\d*H|P[1-9]\d*D)$/, 'Use a duration between PT1H and P7D, e.g. PT24H or P7D.')
  .refine((w) => {
    // A value the regex rejected is reported there; windowMs would throw past the schema.
    if (!/^(PT[1-9]\d*H|P[1-9]\d*D)$/.test(w)) return true;
    const ms = windowMs(w);
    return ms >= MIN_WINDOW_MS && ms <= MAX_WINDOW_MS;
  }, 'The window must be between one hour (PT1H) and seven days (P7D).');

const deliverability = z
  .object({
    metric: z.enum(['bounce', 'complaint']).default('bounce').describe('bounce or complaint'),
    window: Window.default(DEFAULT_WINDOW),
    threshold: z.number().gt(0).max(1).optional().describe('A fraction: 0.05 is 5%. Default 0.05 for bounce and 0.001 for complaint.'),
    minSent: z.number().int().min(1).max(10_000_000).default(100).describe('Do not fire below this many sent messages.'),
  })
  .strict();

const signupDrop = z
  .object({
    window: Window.default(DEFAULT_WINDOW),
    dropPercent: z.number().gt(0).max(100).default(50).describe('Fire when signups fall below this percentage of the previous window.'),
    minPrevious: z.number().int().min(1).max(1_000_000).default(10).describe('The previous window must have at least this many signups.'),
  })
  .strict();

const journeyErrors = z
  .object({
    window: Window.default(DEFAULT_JOURNEY_WINDOW),
    threshold: z.number().gt(0).max(1_000_000).default(5).describe('Fire when more than this many journey steps fail in the window.'),
    journeyId: z
      .string()
      .regex(/^jrn_[0-9a-f]{32}$/, 'A journey id (jrn_…)')
      .optional()
      .describe('Watch one journey; omit to watch every journey in the workspace.'),
  })
  .strict();

const schemas: Record<AlertKind, z.ZodType> = {
  deliverability,
  signup_drop: signupDrop,
  journey_errors: journeyErrors,
};

export interface DeliverabilityConfig {
  metric: 'bounce' | 'complaint';
  window: string;
  threshold: number;
  minSent: number;
}
export interface SignupDropConfig {
  window: string;
  dropPercent: number;
  minPrevious: number;
}
export interface JourneyErrorsConfig {
  window: string;
  threshold: number;
  journeyId?: string;
}
export type AlertConfig = DeliverabilityConfig | SignupDropConfig | JourneyErrorsConfig;

export function parseAlertConfig(kind: AlertKind, raw: unknown): AlertConfig {
  const parsed = schemas[kind].safeParse(raw ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
    throw new AppError('invalid_input', `The configuration for a ${kind} alert is not valid. ${problems}`, z.treeifyError(parsed.error));
  }
  if (kind === 'deliverability') {
    const config = parsed.data as Omit<DeliverabilityConfig, 'threshold'> & { threshold?: number };
    return { ...config, threshold: config.threshold ?? (config.metric === 'complaint' ? 0.001 : 0.05) };
  }
  return parsed.data as AlertConfig;
}

/** The per-rule evaluation floor: no more than four checks per window, and at most hourly. */
export function minimumIntervalMs(config: AlertConfig): number {
  return Math.min(windowMs(config.window) / 4, HOUR);
}

export const AlertChannel = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('webhook'),
      webhookId: z.string().regex(/^whk_[0-9a-f]{32}$/, 'A webhook endpoint id (whk_…)'),
    })
    .strict(),
  z
    .object({
      type: z.literal('email'),
      userIds: z.array(z.string().min(1).max(64)).min(1).max(50).describe('Workspace members by user id'),
    })
    .strict(),
]);
export type AlertChannel = z.infer<typeof AlertChannel>;

export const AlertChannels = z
  .array(AlertChannel)
  .min(1)
  .max(20)
  .describe('Where to notify: existing webhook endpoints and workspace members.')
  .superRefine((channels, ctx) => {
    const seen = new Set<string>();
    for (const [i, channel] of channels.entries()) {
      const id = channel.type === 'webhook' ? channel.webhookId : `email:${[...channel.userIds].sort().join(',')}`;
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [i], message: 'This channel is listed twice.' });
      seen.add(id);
    }
  });

export const AlertKindSchema = z.enum(['deliverability', 'signup_drop', 'journey_errors']);

/** What people read in the UI and in a notification: the measure, not the SQL. */
export function metricLabel(kind: AlertKind, config: AlertConfig): string {
  switch (kind) {
    case 'deliverability':
      return (config as DeliverabilityConfig).metric === 'complaint' ? 'Complaint rate' : 'Bounce rate';
    case 'signup_drop':
      return 'Confirmed signups';
    case 'journey_errors':
      return 'Failed journey steps';
  }
}

export function metricId(kind: AlertKind, config: AlertConfig): string {
  switch (kind) {
    case 'deliverability':
      return (config as DeliverabilityConfig).metric === 'complaint' ? 'email.complaint_rate' : 'email.bounce_rate';
    case 'signup_drop':
      // The metric layer counts the event through `conversions` with a name filter for
      // "Subscription Confirmed"; the human label is "Confirmed signups".
      return 'conversions';
    case 'journey_errors':
      return 'journey.failed';
  }
}

export function isRatioMetric(kind: AlertKind): boolean {
  return kind === 'deliverability';
}
