import type { Out } from '../../../app/api';
import { getWorkspaceTimeZone } from '../../../ui/time';
import { type LocalDayPeriod, periodDateLabel, type ReportPeriodChoice, reportPeriod, returnedPeriodLabel } from '../../broadcasts/period';

// Pure reads and formatting for the campaign roll-up (#511). The server keeps the units and the
// attribution rules; this module only names them, keeps every currency apart, and turns missing,
// suppressed or null cells into Unavailable instead of an observed zero.

export type CampaignSummary = Out<'analytics.campaignSummary'>;
export type NotStartedSummary = Extract<CampaignSummary, { state: 'not_started' }>;
export type MeasuredSummary = Extract<CampaignSummary, { state: 'measured' }>;
export type CampaignHoldoutResult = Out<'campaigns.holdoutResult'>;
export type JourneyHoldoutResult = MeasuredSummary['holdouts'][number];
export type MemberRow = MeasuredSummary['members'][number];
export type FunnelStep = MeasuredSummary['funnel'][number];
export type PeriodChoice = ReportPeriodChoice;

/** The published campaign content the holdout card needs, without importing the whole artifact page. */
export type CampaignArtifactView = {
  id?: string;
  latestVersion: number;
  publishedVersion: number | null;
  version: { number: number; state?: string; content: unknown };
};

export type CampaignDefinitionContent = {
  controlGroup?: { percent: number; minSampleSize?: number | null };
  goal?: { kind?: string; event?: string | null; target?: number | null; attributionDays?: number | null };
};

export function ownPeriod(choice: PeriodChoice, anchor: Date): LocalDayPeriod {
  return reportPeriod(choice, anchor);
}

export function isRealInstant(value: string | null | undefined): value is string {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getFullYear() >= 2000;
}

export function zoneOf(metaTimeZone: string | null | undefined): string {
  return metaTimeZone || getWorkspaceTimeZone();
}

/** Like returnedPeriodLabel, but never turns an epoch or malformed bound into a date. */
export function safeReturnedPeriodLabel(from: string | null | undefined, to: string | null | undefined, zone: string): string | null {
  if (!isRealInstant(from) || !isRealInstant(to)) return null;
  try {
    return returnedPeriodLabel(from, to, zone);
  } catch {
    return null;
  }
}

export function periodLabelOf(
  bounds: { from: string; to: string },
  zone: string,
  returned?: { from?: string | null; to?: string | null },
): string {
  return (
    safeReturnedPeriodLabel(returned?.from, returned?.to, zone) ??
    safeReturnedPeriodLabel(bounds.from, bounds.to, zone) ??
    'Period unavailable'
  );
}

export function ownPeriodLabel(period: LocalDayPeriod): string {
  return periodDateLabel(period);
}

export function int(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en') : '—';
}

/** A server fraction as a one-decimal percent; a null rate stays "—". */
export function percentText(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  const value = Math.round(rate * 1000) / 10;
  return `${value.toLocaleString('en', { maximumFractionDigits: 1 })}%`;
}

/** A rate is available only with a positive denominator. */
export function rateText(rate: number | null | undefined, denominator: number | null | undefined): string {
  if (typeof denominator !== 'number' || denominator <= 0) return 'Unavailable';
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'Unavailable';
  return percentText(rate);
}

export function rateOrDash(rate: number | null | undefined, denominator: number | null | undefined): string {
  const text = rateText(rate, denominator);
  return text === 'Unavailable' ? '—' : text;
}

/** Percentage points, signed, one decimal. absoluteLift and ci95 are fractions. */
export function pointsText(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
  const amount = Math.round(value * 1000) / 10;
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}${Math.abs(amount).toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`;
}

/** A fraction shown as a signed percentage, one decimal. relativeLift is a fraction. */
export function signedPercentText(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
  const amount = Math.round(value * 1000) / 10;
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}${Math.abs(amount).toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function money(amount: number | null | undefined, currency: string): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString('en')} ${currency}`;
  }
}

/** The latest event is event freshness, never a fetch time and never an epoch date. */
export function latestEventText(freshness: string | null | undefined, zone: string): string {
  if (!isRealInstant(freshness)) return 'Unavailable';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(freshness));
  } catch {
    return 'Unavailable';
  }
}

export const STEP_LABEL: Record<FunnelStep['step'], string> = {
  recipients: 'Recipients',
  delivered: 'Delivered',
  clicked: 'Clicked',
  converted: 'Converted',
};

export const PREVIOUS_STEP: Record<FunnelStep['step'], FunnelStep['step'] | null> = {
  recipients: null,
  delivered: 'recipients',
  clicked: 'delivered',
  converted: 'clicked',
};

export const ROLE_LABEL: Record<MemberRow['role'], string> = {
  primary: 'Primary',
  follow_up: 'Follow-up',
  content: 'Content',
};

export function typeLabel(type: string): string {
  return type === 'broadcast' ? 'Broadcast' : type === 'journey' ? 'Journey' : type;
}

export type VerdictTone = 'neutral' | 'good' | 'warn' | 'bad';

/**
 * The server verdict stays authoritative. The roll-up renames its states in the contract's words
 * and never manufactures significance: an insufficient sample or an interval containing zero is
 * inconclusive, even when the point estimate moves.
 */
export function holdoutVerdict(result: { verdict: string; minSampleSizeMet: boolean; ci95: [number, number] | null }): {
  label: string;
  tone: VerdictTone;
} {
  if (!result.minSampleSizeMet || result.verdict === 'not_enough_data') return { label: 'Insufficient sample', tone: 'warn' };
  if (result.verdict === 'no_clear_difference') return { label: 'Inconclusive', tone: 'warn' };
  if (result.ci95 && result.ci95[0] <= 0 && result.ci95[1] >= 0) return { label: 'Inconclusive', tone: 'warn' };
  if (result.verdict === 'treatment_better') return { label: 'Treatment better', tone: 'good' };
  if (result.verdict === 'treatment_worse') return { label: 'Treatment worse', tone: 'bad' };
  return { label: 'Inconclusive', tone: 'warn' };
}

export interface FunnelBar {
  step: FunnelStep['step'];
  label: string;
  count: number | null;
  width: number;
  stepRate: string;
  previous: string | null;
  sharePercent: string;
  shareLabel: string;
}

/**
 * Independent horizontal bars from the returned funnel. Widths are relative to the largest returned
 * count, so they never imply a monotonic funnel and a converter count above the click count stays
 * visible. The visible table below the figure uses the same returned values.
 */
export function funnelBars(funnel: FunnelStep[]): FunnelBar[] {
  const largest = Math.max(1, ...funnel.map((step) => step.count ?? 0));
  return funnel.map((step) => {
    const previousStep = PREVIOUS_STEP[step.step];
    // Delivered divides by e-mail sent, not by all-channel recipients (#586 P3).
    const previous = step.step === 'delivered' ? 'E-mail sent' : previousStep ? STEP_LABEL[previousStep] : null;
    const shareBase = step.step === 'delivered' || step.step === 'clicked' ? 'e-mail sent' : 'recipients';
    return {
      step: step.step,
      label: STEP_LABEL[step.step],
      count: step.count,
      width: Math.max(0, Math.min(100, ((step.count ?? 0) / largest) * 100)),
      stepRate: percentText(step.stepRate),
      previous,
      sharePercent: step.shareOfRecipients === null ? 'Unavailable' : percentText(step.shareOfRecipients),
      shareLabel:
        step.shareOfRecipients === null ? `Share of ${shareBase} unavailable` : `${percentText(step.shareOfRecipients)} of ${shareBase}`,
    };
  });
}

export function memberRateLabel(rate: number | null | undefined, delivered: number | null | undefined): string {
  if (typeof delivered !== 'number' || delivered <= 0) return 'Unavailable';
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'Unavailable';
  return `${percentText(rate)} of ${int(delivered)} delivered`;
}

export function allHeadlineZero(headline: MeasuredSummary['headline']): boolean {
  return [headline.recipients, headline.delivered, headline.clickers, headline.converters, headline.unsubscribers].every(
    (value) => value === 0,
  );
}

export function revenuePerRecipientFor(
  headline: MeasuredSummary['headline'],
  currency: string,
): { currency: string; amount: number | null } | null {
  return headline.revenuePerRecipient.find((row) => row.currency === currency) ?? null;
}

export function targetProgressText(
  targetProgress: number | null | undefined,
  target: number | null | undefined,
  multiCurrency: boolean,
): string {
  if (typeof targetProgress !== 'number' || !Number.isFinite(targetProgress)) {
    return multiCurrency ? 'Progress unavailable · multiple currencies cannot be combined' : 'Progress unavailable';
  }
  const percent = percentText(targetProgress);
  return typeof target === 'number' && Number.isFinite(target) ? `${percent} of target (${int(target)})` : `${percent} of target`;
}

export function goalText(goal: { kind?: string; event?: string | null; target?: number | null; attributionDays?: number | null }): string {
  const kind = goal.kind ?? 'goal';
  return goal.event ? `${kind} · ${goal.event}` : kind;
}

export function isNotFound(error: string | null | undefined): boolean {
  return !!error && /does not exist|not found/i.test(error);
}
