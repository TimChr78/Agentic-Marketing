import type { Out } from '../../../app/api';
import { measureLabel, measureUnit } from '../../../lib/labels';
import { type AnalyticsRange, dayLabel, periodDays } from './period';

// Pure reads for Analytics (#506). Columns are matched by name, never by position. A missing,
// suppressed or null cell stays unavailable instead of becoming an observed zero.

export type AnalyticsResult = Out<'analytics.query'>;
export type Column = AnalyticsResult['columns'][number];

export interface MetaView {
  timeZone: string | null;
  currency: string | null;
  from: string | null;
  to: string | null;
  freshness: string | null;
  suppressed: number;
  k: number | null;
  notes: string[];
}

export interface TotalsView {
  values: Record<string, number | null>;
  /** Revenue per returned currency; amounts are never added across currencies. */
  revenueByCurrency: Record<string, number>;
  /** True only when the read returned a row. */
  complete: boolean;
  meta: MetaView;
}

export interface SeriesDay {
  day: string;
  label: string;
  values: Record<string, number | null>;
  revenueByCurrency: Record<string, number>;
  currencies: string[];
}

export interface SeriesTableRow {
  key: string;
  day: string;
  label: string;
  currency: string | null;
  values: Record<string, number | null>;
}

export interface SeriesView {
  days: SeriesDay[];
  tableRows: SeriesTableRow[];
  meta: MetaView;
}

const numeric = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
};

const text = (value: string | number | null | undefined): string | null => {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

export function metaOf(result: AnalyticsResult | undefined): MetaView {
  return {
    timeZone: result?.meta.timeZone ?? null,
    currency: usableCurrency(result?.meta.currency),
    from: result?.meta.from ?? null,
    to: result?.meta.to ?? null,
    freshness: freshnessOf(result?.meta.freshness),
    suppressed: result?.meta.suppressed ?? 0,
    k: result?.meta.k ?? null,
    notes: result?.meta.notes ?? [],
  };
}

/** A currency is usable only when it names a real currency; UNKNOWN is not metadata. */
export function usableCurrency(value: string | null | undefined): string | null {
  if (!value) return null;
  const currency = value.trim().toUpperCase();
  if (!currency || currency === 'UNKNOWN') return null;
  return currency;
}

/** Null/epoch freshness is unknown; the fetch time is never a substitute (#438). */
export function freshnessOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return null;
  return value;
}

function columnIndex(result: AnalyticsResult, name: string): number {
  return result.columns.findIndex((column) => column.name === name);
}

function cell(result: AnalyticsResult, row: (string | number | null)[], name: string): number | null {
  const index = columnIndex(result, name);
  return index >= 0 ? numeric(row[index]) : null;
}

function rowCurrency(result: AnalyticsResult, row: (string | number | null)[]): string | null {
  const index = columnIndex(result, 'currency');
  return index >= 0 ? usableCurrency(text(row[index])) : null;
}

export function emptyValues(measures: readonly string[]): Record<string, number | null> {
  return Object.fromEntries(measures.map((id) => [id, null])) as Record<string, number | null>;
}

/** The totals read: one row per currency when revenue is implicit. Separate units are never summed. */
export function readTotals(result: AnalyticsResult | undefined, measures: readonly string[]): TotalsView {
  const values = emptyValues(measures);
  const revenueByCurrency: Record<string, number> = {};
  const rows = result?.rows ?? [];
  if (!result || !rows.length) return { values, revenueByCurrency, complete: false, meta: metaOf(result) };

  const currencies = new Set<string>();
  for (const row of rows) {
    const currency = rowCurrency(result, row);
    if (currency) currencies.add(currency);
    for (const id of measures) {
      const value = cell(result, row, id);
      if (id === 'revenue' || measureUnit(id) === 'currency') {
        if (value === null) continue;
        const key = currency ?? 'UNKNOWN';
        revenueByCurrency[key] = (revenueByCurrency[key] ?? 0) + value;
        // A single-currency result can also expose the amount as a scalar.
        values[id] = currencies.size <= 1 ? (values[id] ?? 0) + value : null;
      } else if (value !== null) {
        // Counts are distinct per currency group; the groups partition events, so summing them
        // across currency rows keeps the period total. Ratios arrive from the server per row.
        values[id] = measureUnit(id) === 'ratio' ? (values[id] ?? value) : (values[id] ?? 0) + value;
      }
    }
  }
  return { values, revenueByCurrency, complete: true, meta: metaOf(result) };
}

function aggregateDay(
  rows: { values: Record<string, number | null>; currency: string | null }[],
  measures: readonly string[],
): { values: Record<string, number | null>; revenueByCurrency: Record<string, number>; currencies: string[] } {
  const values = emptyValues(measures);
  const revenueByCurrency: Record<string, number> = {};
  const currencies = new Set<string>();
  for (const row of rows) {
    if (row.currency) currencies.add(row.currency);
    for (const id of measures) {
      const value = row.values[id];
      if (value === null) continue;
      if (measureUnit(id) === 'currency') {
        revenueByCurrency[row.currency ?? 'UNKNOWN'] = (revenueByCurrency[row.currency ?? 'UNKNOWN'] ?? 0) + value;
        values[id] = currencies.size <= 1 ? (values[id] ?? 0) + value : null;
      } else if (measureUnit(id) === 'ratio') {
        values[id] = values[id] ?? value;
      } else {
        values[id] = (values[id] ?? 0) + value;
      }
    }
  }
  return { values, revenueByCurrency, currencies: [...currencies] };
}

/** The daily series read: every local day in the period, with an absent day kept as a gap. */
export function readSeries(
  result: AnalyticsResult | undefined,
  range: Pick<AnalyticsRange, 'fromDate' | 'toDate'>,
  measures: readonly string[],
): SeriesView {
  const rawByDay = new Map<string, { values: Record<string, number | null>; currency: string | null }[]>();
  const tableRows: SeriesTableRow[] = [];
  if (result) {
    const dayIndex = columnIndex(result, 'day');
    if (dayIndex >= 0) {
      for (const row of result.rows) {
        const day = text(row[dayIndex]);
        if (!day) continue;
        const values = emptyValues(measures);
        for (const id of measures) values[id] = cell(result, row, id);
        const currency = rowCurrency(result, row);
        const entry = { values, currency };
        const list = rawByDay.get(day) ?? [];
        list.push(entry);
        rawByDay.set(day, list);
        tableRows.push({ key: `${day}-${currency ?? 'row'}-${tableRows.length}`, day, label: dayLabel(day), currency, values });
      }
    }
  }

  const days = periodDays(range).map((day) => {
    const rows = rawByDay.get(day) ?? [];
    const aggregated = aggregateDay(rows, measures);
    return { day, label: dayLabel(day), ...aggregated };
  });

  // A day the read did not return is a gap, but it still appears in the table with em dashes.
  const returnedDays = new Set(tableRows.map((row) => row.day));
  for (const day of periodDays(range)) {
    if (returnedDays.has(day)) continue;
    tableRows.push({ key: `${day}-missing`, day, label: dayLabel(day), currency: null, values: emptyValues(measures) });
  }
  tableRows.sort((a, b) => (a.day === b.day ? (a.currency ?? '').localeCompare(b.currency ?? '') : a.day.localeCompare(b.day)));

  return { days, tableRows, meta: metaOf(result) };
}

export function seriesHasValues(days: readonly SeriesDay[], measures: readonly string[]): boolean {
  return days.some((day) => measures.some((measure) => day.values[measure] !== null));
}

/** True when the read returned explicit zeros for every selected base count. */
export function allObservedZero(totals: TotalsView, measures: readonly string[]): boolean {
  if (!totals.complete) return false;
  const counts = measures.filter((id) => measureUnit(id) === 'count' && id !== 'conversions');
  return counts.length > 0 && counts.every((id) => totals.values[id] === 0);
}

// ---------------------------------------------------------------------------------------------
// Period comparison
// ---------------------------------------------------------------------------------------------

export type DeltaDirection = 'up' | 'down' | 'none';
export type DeltaTone = 'good' | 'bad' | 'neutral';

export interface Comparison {
  /** "Prior 2,160 · +11.1%" or "Prior — · Unavailable". */
  text: string;
  direction: DeltaDirection;
  tone: DeltaTone;
}

export type Favourable = 'up' | 'down' | null;

function toneOf(direction: DeltaDirection, favourable: Favourable): DeltaTone {
  if (direction === 'none' || favourable === null) return 'neutral';
  return direction === favourable ? 'good' : 'bad';
}

const signed = (amount: number, suffix: string): string =>
  `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}${suffix}`;

/** Counts compare relatively; a zero prior has no relative change. */
export function countDelta(
  current: number | null | undefined,
  prior: number | null | undefined,
  favourable: Favourable = 'up',
): Comparison {
  if (current === null || current === undefined || prior === null || prior === undefined)
    return { text: 'No comparable baseline', direction: 'none', tone: 'neutral' };
  if (prior === 0) return { text: 'No comparable baseline', direction: 'none', tone: 'neutral' };
  const change = ((current - prior) / Math.abs(prior)) * 100;
  const amount = Math.round(change * 10) / 10;
  if (amount === 0) return { text: 'No change', direction: 'none', tone: 'neutral' };
  const direction: DeltaDirection = amount > 0 ? 'up' : 'down';
  return { text: signed(amount, '%'), direction, tone: toneOf(direction, favourable) };
}

/** Rates compare in percentage points; the server stores a fraction, the delta is ×100. */
export function rateDelta(current: number | null | undefined, prior: number | null | undefined, favourable: Favourable = 'up'): Comparison {
  if (current === null || current === undefined || prior === null || prior === undefined)
    return { text: 'No comparable baseline', direction: 'none', tone: 'neutral' };
  const change = (current - prior) * 100;
  const amount = Math.round(change * 10) / 10;
  if (amount === 0) return { text: 'No change', direction: 'none', tone: 'neutral' };
  const direction: DeltaDirection = amount > 0 ? 'up' : 'down';
  return { text: signed(amount, ' pp'), direction, tone: toneOf(direction, favourable) };
}

export function countComparison(
  current: number | null | undefined,
  prior: number | null | undefined,
  format: (value: number) => string,
  favourable: Favourable = 'up',
): Comparison {
  if (current === null || current === undefined || prior === null || prior === undefined || prior === 0) {
    return {
      text: `Prior ${prior === null || prior === undefined ? '—' : format(prior)} · No comparable baseline`,
      direction: 'none',
      tone: 'neutral',
    };
  }
  const delta = countDelta(current, prior, favourable);
  return { ...delta, text: `Prior ${format(prior)} · ${delta.text}` };
}

export function rateComparison(
  current: number | null | undefined,
  prior: number | null | undefined,
  format: (value: number) => string,
  favourable: Favourable = 'up',
): Comparison {
  if (current === null || current === undefined || prior === null || prior === undefined) {
    return {
      text: `Prior ${prior === null || prior === undefined ? '—' : format(prior)} · No comparable baseline`,
      direction: 'none',
      tone: 'neutral',
    };
  }
  const delta = rateDelta(current, prior, favourable);
  return { ...delta, text: `Prior ${format(prior)} · ${delta.text}` };
}

/** A period count that covers a zero prior still shows its absolute value. */
export function zeroPriorVisible(current: number | null | undefined, prior: number | null | undefined): boolean {
  return current !== null && current !== undefined && prior === 0;
}

// ---------------------------------------------------------------------------------------------
// Currency gate
// ---------------------------------------------------------------------------------------------

export type RevenueGate = { ok: true; currency: string } | { ok: false; reason: 'mixed' | 'missing' | 'different' };

/**
 * A revenue chart needs one usable currency in this result, and the same currency in the
 * comparison result. A mixed or missing currency keeps the currency-labelled table rows.
 */
export function revenueGate(input: {
  currentMeta: MetaView;
  currentCurrencies: readonly string[];
  priorMeta?: MetaView | null;
  priorCurrencies?: readonly string[];
  comparing: boolean;
}): RevenueGate {
  const { currentMeta, currentCurrencies, priorMeta, priorCurrencies = [], comparing } = input;
  const current = usableCurrency(currentMeta.currency);
  if (!current) return { ok: false, reason: currentCurrencies.length > 1 ? 'mixed' : 'missing' };
  if (currentCurrencies.length > 1) return { ok: false, reason: 'mixed' };
  if (!comparing) return { ok: true, currency: current };
  const prior = usableCurrency(priorMeta?.currency);
  if (!prior || prior !== current) return { ok: false, reason: 'different' };
  if (priorCurrencies.length > 1) return { ok: false, reason: 'mixed' };
  return { ok: true, currency: current };
}

export const REVENUE_UNAVAILABLE = 'Revenue chart unavailable — result contains multiple currencies or no currency information.';

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString();
}

/** A stored fraction as a one-decimal percentage. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(Math.round(fraction * 1000) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const code = usableCurrency(currency);
  if (!code) return 'Unavailable';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toLocaleString('en')} ${code}`;
  }
}

export function formatMeasure(value: number | null | undefined, measureId: string, currency?: string | null): string {
  const unit = measureUnit(measureId);
  if (unit === 'ratio') return formatPercent(value);
  if (unit === 'currency') return formatMoney(value, currency);
  return formatCount(value);
}

export function measureWords(measureId: string): string {
  return measureLabel(measureId).toLowerCase();
}

export function ratioPercent(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}
