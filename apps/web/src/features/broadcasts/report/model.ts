import type { Out } from '../../../app/api';
import type { ChartDataState, KpiDataState } from '../../../ui/charts';
import { dayLabel, type LocalDayPeriod } from '../period';

// Pure reads for the broadcast Report (#500). Analytics queries return columns by name, never by a
// fixed position, and a missing, suppressed or null cell stays unavailable instead of becoming an
// observed zero.

type AnalyticsResult = Out<'analytics.query'>;

export const TOTAL_MEASURES = [
  'email.sent',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
  'email.unsubscribed',
  'email.open_rate',
  'email.click_rate',
  'email.unsubscribe_rate',
] as const;

export type TotalMeasure = (typeof TOTAL_MEASURES)[number];
export type Totals = Record<TotalMeasure, number | null>;

export const SERIES_MEASURES = ['email.sent', 'email.delivered', 'email.opened', 'email.clicked', 'email.unsubscribed'] as const;

export type SeriesMeasure = (typeof SERIES_MEASURES)[number];

export interface AnalyticsMetaView {
  timeZone: string | null;
  from: string | null;
  to: string | null;
  freshness: string | null;
  suppressed: number;
  k: number | null;
  notes: string[];
}

export interface TotalsView {
  values: Totals;
  /** A row was returned; without it, even "all zero" is not a complete observation. */
  complete: boolean;
  meta: AnalyticsMetaView;
}

export interface SeriesDay {
  day: string;
  label: string;
  values: Record<SeriesMeasure, number | null>;
}

export interface SeriesView {
  days: SeriesDay[];
  meta: AnalyticsMetaView;
}

const numeric = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
};

const cell = (result: AnalyticsResult, row: (string | number | null)[], name: string): number | null => {
  const index = result.columns.findIndex((column) => column.name === name);
  return index >= 0 ? numeric(row[index]) : null;
};

/** Null/epoch freshness is unknown; the query time is never a substitute (#438). */
export function freshnessOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return null;
  return value;
}

export function metaOf(result: AnalyticsResult | undefined): AnalyticsMetaView {
  return {
    timeZone: result?.meta.timeZone ?? null,
    from: result?.meta.from ?? null,
    to: result?.meta.to ?? null,
    freshness: freshnessOf(result?.meta.freshness),
    suppressed: result?.meta.suppressed ?? 0,
    k: result?.meta.k ?? null,
    notes: result?.meta.notes ?? [],
  };
}

export function readTotals(result: AnalyticsResult | undefined): TotalsView {
  const values = Object.fromEntries(TOTAL_MEASURES.map((id) => [id, null])) as Totals;
  const row = result?.rows[0];
  if (result && row) {
    for (const id of TOTAL_MEASURES) values[id] = cell(result, row, id);
  }
  return { values, complete: !!row, meta: metaOf(result) };
}

const emptyDayValues = (): Record<SeriesMeasure, number | null> =>
  Object.fromEntries(SERIES_MEASURES.map((id) => [id, null])) as Record<SeriesMeasure, number | null>;

/** Every local calendar day in the selected period, inclusive, as YYYY-MM-DD. */
function periodDays(period: Pick<LocalDayPeriod, 'fromDate' | 'toDate'>): string[] {
  const start = new Date(`${period.fromDate}T00:00:00.000Z`);
  const end = new Date(`${period.toDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const days: string[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The series read on the selected calendar axis. A day the query did not return is a gap (null),
 * never an observed zero, so the chart cannot draw straight across a missing day. A returned zero
 * stays an observed zero.
 */
export function readSeries(result: AnalyticsResult | undefined, period: Pick<LocalDayPeriod, 'fromDate' | 'toDate'>): SeriesView {
  const returned = new Map<string, Record<SeriesMeasure, number | null>>();
  if (result) {
    const index = result.columns.findIndex((column) => column.name === 'day');
    if (index >= 0) {
      for (const row of result.rows) {
        const day = row[index];
        if (typeof day !== 'string' || !day) continue;
        returned.set(
          day,
          Object.fromEntries(SERIES_MEASURES.map((id) => [id, cell(result, row, id)])) as Record<SeriesMeasure, number | null>,
        );
      }
    }
  }
  const days = periodDays(period).map((day) => ({
    day,
    label: dayLabel(day),
    values: returned.get(day) ?? emptyDayValues(),
  }));
  return { days, meta: metaOf(result) };
}

/** A daily series is "no data" only when every returned cell is absent; an observed over is 0. */
export function seriesHasValues(days: SeriesDay[], measures: SeriesMeasure[]): boolean {
  return days.some((day) => measures.some((measure) => day.values[measure] !== null));
}

export function seriesValues(days: SeriesDay[], measure: SeriesMeasure): (number | null)[] {
  return days.map((day) => day.values[measure]);
}

/** A ratio is stored as a fraction; the report rounds to one decimal percent. */
export function percentOf(fraction: number | null | undefined): number | null {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return null;
  return Math.round(fraction * 1000) / 10;
}

/** A rate needs a real numerator and a positive denominator; zero delivered people is unavailable. */
export function ratePercent(fraction: number | null | undefined, denominator: number | null | undefined): number | null {
  if (denominator === null || denominator === undefined || denominator <= 0) return null;
  return percentOf(fraction);
}

export function unavailableReason(reason: 'no-delivered' | 'unavailable'): string {
  return reason === 'no-delivered' ? 'No delivered people to divide by' : 'Unavailable';
}

/** A rate reason follows the denominator it actually has; suppression is never shown as a zero rate. */
export function rateReason(input: { denominator: number | null; suppressed: number }): string {
  if (input.suppressed > 0) return 'Fewer than 5 people';
  if (input.denominator === null) return unavailableReason('unavailable');
  if (input.denominator <= 0) return unavailableReason('no-delivered');
  return unavailableReason('unavailable');
}

export function tileState(value: number | null, suppressed: number): KpiDataState {
  if (value !== null) return 'populated';
  return suppressed > 0 ? 'suppressed' : 'no-data';
}

export function tileExplanation(value: number | null, suppressed: number, reason = 'Unavailable'): string | undefined {
  if (value !== null) return undefined;
  return suppressed > 0 ? 'Fewer than 5 people' : reason;
}

/** Known all-zero complete data is not a failed read; a row must exist before it counts. */
export function allTotalsZero(view: TotalsView): boolean {
  if (!view.complete) return false;
  const observed = [
    view.values['email.sent'],
    view.values['email.delivered'],
    view.values['email.bounced'],
    view.values['email.complained'],
    view.values['email.opened'],
    view.values['email.clicked'],
    view.values['email.unsubscribed'],
  ];
  return observed.every((value) => value === 0);
}

export function deliveryChartState(view: TotalsView): ChartDataState {
  const values = [view.values['email.sent'], view.values['email.delivered'], view.values['email.bounced'], view.values['email.complained']];
  if (values.every((value) => value === null)) return view.meta.suppressed > 0 ? 'suppressed' : 'no-data';
  if (values.every((value) => value === 0)) return 'no-data';
  return 'populated';
}

// ---------------------------------------------------------------------------------------------
// Campaign holdout
// ---------------------------------------------------------------------------------------------

export type CampaignMembership = Out<'campaigns.of'>['campaigns'][number];
export type HoldoutResult = Out<'campaigns.holdoutResult'>;

export interface CampaignControl {
  percent: number;
  minSampleSize: number | null;
}

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The published content's controlGroup; a draft's control is never used for measurement. */
export function controlGroupOf(content: unknown): CampaignControl | null {
  if (!content || typeof content !== 'object') return null;
  const control = (content as { controlGroup?: unknown }).controlGroup;
  if (!control || typeof control !== 'object') return null;
  const percent = numberOrNull((control as { percent?: unknown }).percent);
  if (percent === null) return null;
  return { percent, minSampleSize: numberOrNull((control as { minSampleSize?: unknown }).minSampleSize) };
}

export type HoldoutVerdict = { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' };

/**
 * The server verdict stays authoritative. The report only renames its states in the contract's
 * words and never invents significance: an insufficient sample or an interval containing zero is
 * inconclusive even when the point estimate moves.
 */
export function holdoutVerdict(result: Pick<HoldoutResult, 'verdict' | 'minSampleSizeMet' | 'ci95'>): HoldoutVerdict {
  if (!result.minSampleSizeMet) return { label: 'Insufficient sample', tone: 'warn' };
  if (result.verdict === 'not_enough_data') return { label: 'Insufficient sample', tone: 'warn' };
  if (result.verdict === 'no_clear_difference') return { label: 'Inconclusive', tone: 'warn' };
  const includesZero = !!result.ci95 && result.ci95[0] <= 0 && result.ci95[1] >= 0;
  if (includesZero) return { label: 'Inconclusive', tone: 'warn' };
  if (result.verdict === 'treatment_better') return { label: 'Treatment better', tone: 'good' };
  if (result.verdict === 'treatment_worse') return { label: 'Treatment worse', tone: 'bad' };
  return { label: 'Inconclusive', tone: 'warn' };
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
  return `${Math.round(value * 1000) / 10}%`;
}

export function armRate(rate: number, entered: number): string {
  if (!entered) return 'Unavailable';
  return pct(rate);
}

/** Percentage points, signed, one decimal. */
export function points(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
  const amount = Math.round(value * 1000) / 10;
  return `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`;
}

/** A fraction shown as a signed percentage, one decimal. */
export function signedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
  const amount = Math.round(value * 1000) / 10;
  return `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** Revenue is a currency→amount map; each returned currency keeps its own amount and is never summed. */
export function moneyMap(revenue: Record<string, number> | undefined): string {
  const entries = Object.entries(revenue ?? {}).filter(([, amount]) => Number.isFinite(amount));
  if (!entries.length) return 'Unavailable';
  return entries
    .map(([currency, amount]) => {
      try {
        return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
      } catch {
        return `${amount.toLocaleString('en')} ${currency}`;
      }
    })
    .join(' · ');
}
