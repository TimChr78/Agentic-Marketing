import type { EChartsOption } from 'echarts';
import { AlertCircle } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Chart, type ChartColors } from '../components/Chart';
import { Button } from './Button';
import { cx } from './cx';
import { Skeleton } from './display';

// Chart primitives (DESIGN.md → Data visualisation and Chart contract). Callers supply labelled
// data; the primitives own formatting, data states, the accessible table fallback and the direct
// labels. Colours come from the categorical `--viz-*` tokens in stable series order, never from
// state colours and never from the legacy agent colour.

export type ChartDataState = 'populated' | 'no-data' | 'below-volume' | 'suppressed' | 'loading' | 'error';

export type ChartSeriesInput = {
  label: string;
  values: (number | null)[];
  /** 0-based index into the categorical palette; omit to keep the series' position. */
  viz?: number;
  /** A comparison series is dashed and explicitly labelled "Previous period" by the caller. */
  dashed?: boolean;
  area?: boolean;
};

const withUnit = (v: number | null, unit?: string): string => {
  if (v === null || !Number.isFinite(v)) return '—';
  if (unit === '%') return `${v.toLocaleString()}%`;
  return unit ? `${v.toLocaleString()} ${unit}` : v.toLocaleString();
};

type ChartBlockProps = {
  title: string;
  subtitle?: ReactNode;
  /** Summary sentence outside the SVG: what the chart answers and its denominator, if any. */
  summary?: ReactNode;
  dataState?: ChartDataState;
  stateMessage?: ReactNode;
  onRetry?: () => void;
  height?: number;
  unit?: string;
  formatValue?: (value: number | null) => string;
  className?: string;
  /** Extra note under the plot, e.g. a truncated series or aggregation rule. */
  note?: ReactNode;
};

function StateBlock({ state, message, onRetry }: { state: ChartDataState; message?: ReactNode; onRetry?: () => void }) {
  if (state === 'loading')
    return (
      <div role="status" aria-busy="true" aria-label="Loading performance" className="space-y-2.5 py-3">
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-[120px] w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    );
  const copy: Record<Exclude<ChartDataState, 'populated' | 'loading'>, string> = {
    'no-data': 'No data in this period.',
    'below-volume': 'Below evaluation volume.',
    suppressed: 'Suppressed · fewer than 5 people.',
    error: 'Performance unavailable. Retry.',
  };
  const tone = state === 'error' ? 'text-bad' : 'text-muted';
  return (
    <div className="flex min-h-[200px] flex-col items-start justify-center gap-2 rounded-lg bg-surface-2 px-4 py-5">
      <p className={cx('flex items-center gap-2 text-[14px] leading-[22px]', tone)}>
        {state === 'error' && <AlertCircle size={16} aria-hidden />}
        {message ?? copy[state as Exclude<ChartDataState, 'populated' | 'loading'>]}
      </p>
      {state === 'error' && onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function DataTable({
  title,
  labels,
  series,
  format,
  unit,
  state,
}: {
  title: string;
  labels: string[];
  series: ChartSeriesInput[];
  format: (value: number | null) => string;
  unit?: string;
  state: ChartDataState;
}) {
  const unitSuffix = unit ? ` (${unit})` : '';
  return (
    <details className="mt-3">
      <summary className="flex min-h-10 cursor-pointer items-center text-[12px] leading-[18px] font-medium text-accent pointer-coarse:min-h-10 md:min-h-0">
        Show data table
      </summary>
      <div className="mt-2 overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">{title}</caption>
          <thead className="bg-surface-2 text-muted">
            <tr>
              <th scope="col" className="h-9 px-3 font-medium whitespace-nowrap">
                Period
              </th>
              {series.map((s) => (
                <th key={s.label} scope="col" className="h-9 px-3 text-right font-medium whitespace-nowrap">
                  {s.label}
                  {unitSuffix}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state === 'populated' ? (
              labels.map((label, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: chart labels are a positional axis; duplicates are possible and rows never reorder
                <tr key={`${label}-${i}`} className="border-t border-line">
                  <th scope="row" className="px-3 py-2 text-left font-normal text-fg-2">
                    {label}
                  </th>
                  {series.map((s) => (
                    <td key={s.label} className="num px-3 py-2 text-right text-fg-2">
                      {format(s.values[i] ?? null)}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr className="border-t border-line">
                <td colSpan={series.length + 1} className="px-3 py-3 text-muted">
                  {state === 'loading' ? 'Loading performance' : 'No values to show.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ChartBlockShell({
  title,
  subtitle,
  summary,
  note,
  className,
  children,
  table,
}: ChartBlockProps & { children: ReactNode; table: ReactNode }) {
  const id = useId().replace(/:/g, '');
  return (
    <figure aria-labelledby={id} className={cx('min-w-0 bg-surface', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={id} className="text-[16px] leading-6 font-semibold">
          {title}
        </h3>
      </div>
      {subtitle && <p className="mt-1 text-[12px] leading-[18px] text-muted">{subtitle}</p>}
      <div className="mt-4">{children}</div>
      {note && <p className="mt-2 text-[12px] leading-[18px] text-muted">{note}</p>}
      {summary && <p className="mt-2 text-[12px] leading-[18px] text-fg-2">{summary}</p>}
      {table}
    </figure>
  );
}

export interface LineChartProps extends ChartBlockProps {
  labels: string[];
  series: ChartSeriesInput[];
  /** Fill the first (or a `.area`) series with its colour at 8%. */
  area?: boolean;
}

/** A line (or area) chart with direct end labels, a quiet grid and a table fallback. */
export function LineChart({ labels, series, area, height = 240, unit, formatValue, dataState = 'populated', ...p }: LineChartProps) {
  const state = dataState;
  const plotted = series.slice(0, 3);
  const format = formatValue ?? ((v: number | null) => withUnit(v, unit));
  const option = (c: ChartColors): EChartsOption => ({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, axisTick: { show: false } },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      minInterval: unit === '%' ? undefined : 1,
      axisLabel: unit === '%' ? { formatter: '{value}%' } : undefined,
    },
    series: plotted.map((s, i) => {
      const color = c.viz[(s.viz ?? i) % c.viz.length];
      const points = s.values.filter((v) => v !== null).length;
      return {
        name: s.label,
        type: 'line',
        smooth: false,
        showSymbol: points <= 12,
        symbol: 'circle',
        symbolSize: 6,
        connectNulls: false,
        data: s.values,
        lineStyle: { width: 2, color, type: s.dashed ? 'dashed' : 'solid' },
        itemStyle: { color },
        areaStyle: area || s.area ? { color, opacity: 0.08 } : undefined,
        labelLayout: { moveOverlap: 'shiftY', hideOverlap: false },
        endLabel: {
          show: true,
          formatter: '{a}',
          color: c.fg,
          fontSize: 12,
          lineHeight: 18,
          distance: 8,
        },
      };
    }),
  });
  return (
    <ChartBlockShell
      {...p}
      dataState={state}
      table={<DataTable title={p.title} labels={labels} series={plotted} format={format} unit={unit} state={state} />}
    >
      {state === 'populated' ? (
        <>
          <Chart option={option} height={height} deps={[labels, plotted, unit]} />
          {series.length > plotted.length && (
            <p className="mt-2 text-[12px] leading-[18px] text-muted">
              Showing the first three series in the plot; the table has all {series.length}.
            </p>
          )}
        </>
      ) : (
        <StateBlock state={state} message={p.stateMessage} onRetry={p.onRetry} />
      )}
    </ChartBlockShell>
  );
}

/** A line chart whose first series is filled with the same visible stroke (8% opacity). */
export function AreaChart(props: LineChartProps) {
  return <LineChart {...props} area />;
}

export interface BarChartProps extends ChartBlockProps {
  data: { label: string; value: number | null }[];
  /** Keep the caller's order for inherently ordered categories; otherwise sort descending. */
  ordered?: boolean;
}

/** Horizontal bars: one series, zero baseline, values at the end, at most eight categories. */
export function BarChart({ data, ordered, height = 240, unit, formatValue, dataState = 'populated', ...p }: BarChartProps) {
  const state = dataState;
  const sorted = ordered
    ? [...data]
    : [...data].sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY));
  const shown = sorted.slice(0, 8);
  const format = formatValue ?? ((v: number | null) => withUnit(v, unit));
  const option = (c: ChartColors): EChartsOption => ({
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'value',
      splitNumber: 3,
      minInterval: unit === '%' ? undefined : 1,
      axisLabel: unit === '%' ? { formatter: '{value}%' } : undefined,
    },
    yAxis: { type: 'category', inverse: true, data: shown.map((d) => d.label) },
    series: [
      {
        name: p.title,
        type: 'bar',
        barMaxWidth: 20,
        data: shown.map((d) => d.value),
        itemStyle: { color: c.viz[0] },
        label: {
          show: true,
          position: 'right',
          color: c.fg,
          fontSize: 12,
          lineHeight: 18,
          formatter: (params: { value?: unknown }) => format(typeof params.value === 'number' ? params.value : null),
        },
      },
    ],
  });
  return (
    <ChartBlockShell
      {...p}
      dataState={state}
      table={
        <DataTable
          title={p.title}
          labels={shown.map((d) => d.label)}
          series={[{ label: p.title, values: shown.map((d) => d.value) }]}
          format={format}
          unit={unit}
          state={state}
        />
      }
    >
      {state === 'populated' ? (
        <>
          <Chart option={option} height={height} deps={[shown, unit]} />
          {sorted.length > shown.length && (
            <p className="mt-2 text-[12px] leading-[18px] text-muted">
              Showing the first eight of {sorted.length}. Group smaller categories only when that aggregation is meaningful.
            </p>
          )}
        </>
      ) : (
        <StateBlock state={state} message={p.stateMessage} onRetry={p.onRetry} />
      )}
    </ChartBlockShell>
  );
}

// ---------------------------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------------------------

export type KpiDataState = 'populated' | 'no-data' | 'below-volume' | 'suppressed' | 'loading';
export type KpiDirection = 'up' | 'down' | 'neutral';
export type KpiUnit = 'count' | '%' | 'currency' | 'duration';

export interface KpiTileProps {
  label: string;
  value: number | null;
  unit?: KpiUnit;
  currency?: string;
  precision?: number;
  numerator?: number;
  denominator?: number;
  /** e.g. "1–31 Oct 2026 · UTC". */
  period?: ReactNode;
  previousValue?: number | null;
  comparisonLabel?: string;
  /** Which direction is good; a bounce rate is `down`. Never inferred from sign alone. */
  favourableDirection?: KpiDirection;
  sparkline?: number[];
  updatedAt?: string | Date | null;
  /** Freshness threshold in milliseconds; supplied by the data source, never invented. */
  staleAfter?: number;
  dataState?: KpiDataState;
  explanation?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** The big value and its 14/22 unit suffix (DESIGN.md → KPI tile). */
const formatValue = (
  value: number,
  unit: KpiUnit | undefined,
  precision: number | undefined,
  currency: string | undefined,
): { main: string; unit: string | null } => {
  if (unit === '%') return { main: value.toLocaleString(undefined, { maximumFractionDigits: precision ?? 1 }), unit: '%' };
  if (unit === 'currency')
    return {
      main: value.toLocaleString(undefined, { maximumFractionDigits: precision ?? 2, minimumFractionDigits: 0 }),
      unit: currency ?? 'USD',
    };
  if (unit === 'duration') {
    const s = Math.max(0, Math.round(value));
    if (s < 60) return { main: `${s}`, unit: 's' };
    if (s < 3600) return { main: `${Math.floor(s / 60)}m ${s % 60}`, unit: 's' };
    return { main: `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}`, unit: 'm' };
  }
  return { main: value.toLocaleString(undefined, { maximumFractionDigits: precision ?? 0 }), unit: null };
};

export type DeltaDescription = { text: string; direction: 'up' | 'down' | 'none'; tone: 'good' | 'bad' | 'neutral' };

/**
 * Direction-aware delta copy (DESIGN.md → KPI tile). Percentage rates compare in percentage
 * points; counts and other magnitudes compare relatively. A zero baseline has no percentage
 * change and says so instead of rendering infinity.
 */
export function describeDelta({
  value,
  previousValue,
  unit,
  favourableDirection = 'neutral',
  precision = 1,
}: {
  value: number;
  previousValue: number | null | undefined;
  unit?: KpiUnit;
  favourableDirection?: KpiDirection;
  precision?: number;
}): DeltaDescription {
  if (previousValue === null || previousValue === undefined) return { text: 'No comparable baseline', direction: 'none', tone: 'neutral' };
  const points = unit === '%';
  const change = points ? value - previousValue : previousValue === 0 ? null : ((value - previousValue) / Math.abs(previousValue)) * 100;
  if (change === null) return { text: 'No comparable baseline', direction: 'none', tone: 'neutral' };
  if (Math.abs(change) < 10 ** -precision / 2) return { text: 'No change', direction: 'none', tone: 'neutral' };
  const direction = change > 0 ? 'up' : 'down';
  const amount = Math.abs(change).toFixed(precision);
  const text = points
    ? `${direction === 'up' ? '↑' : '↓'} ${amount} pp ${direction === 'up' ? 'higher' : 'lower'}`
    : `${direction === 'up' ? '↑' : '↓'} ${amount}% ${direction === 'up' ? 'more' : 'fewer'}`;
  const favourable = favourableDirection === 'neutral' ? 'neutral' : direction === favourableDirection ? 'good' : 'bad';
  return { text, direction, tone: favourable };
}

function freshnessText(updatedAt: string | Date | null | undefined, staleAfter?: number): string {
  if (!updatedAt) return 'Updated time not available';
  const at = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  // A missing source value is often zero/epoch. Never render 1/1/1970 as freshness (#438).
  if (Number.isNaN(at.getTime()) || at.getFullYear() < 2000) return 'Updated time not available';
  const s = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
  const relative =
    s < 45
      ? 'just now'
      : s < 3600
        ? `${Math.max(1, Math.round(s / 60))} min ago`
        : s < 86_400
          ? `${Math.round(s / 3600)} h ago`
          : `${Math.round(s / 86_400)} d ago`;
  const stale = staleAfter !== undefined && Date.now() - at.getTime() > staleAfter;
  return `Updated ${relative}${stale ? ' · stale' : ''}`;
}

function Sparkline({ points }: { points: number[] }) {
  const values = points.filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = values.map((v, i) => `${(i / (values.length - 1)) * 92 + 2},${30 - ((v - min) / span) * 28 + 1}`).join(' ');
  return (
    <svg width="96" height="32" viewBox="0 0 96 32" aria-hidden="true" focusable="false" className="shrink-0">
      <polyline points={coords} fill="none" stroke="var(--viz-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * KPI tile: label, value/unit, direction-aware delta, sparkline, period, denominator and
 * freshness. Data states never render a healthy-looking zero for absent data.
 */
export function KpiTile({
  label,
  value,
  unit = 'count',
  currency,
  precision,
  numerator,
  denominator,
  period,
  previousValue,
  comparisonLabel,
  favourableDirection = 'neutral',
  sparkline,
  updatedAt,
  staleAfter,
  dataState = 'populated',
  explanation,
  action,
  className,
}: KpiTileProps) {
  if (dataState === 'loading') {
    return (
      <section aria-busy="true" aria-label={label} className={cx('flex min-h-[204px] flex-col rounded-lg bg-surface p-5', className)}>
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="mt-3 h-8 w-1/2" />
        <Skeleton className="mt-3 h-3 w-3/5" />
        <Skeleton className="mt-auto h-3 w-2/5" />
      </section>
    );
  }

  const suppressed = dataState === 'suppressed';
  const belowVolume = dataState === 'below-volume';
  const missing = dataState === 'no-data' || value === null;
  // A rate below evaluation volume is withheld; a count may still be shown.
  const shownValue = suppressed || (belowVolume && unit === '%') || missing ? null : value;
  const formatted = shownValue === null ? null : formatValue(shownValue, unit, precision, currency);
  const valueText = formatted?.main ?? '—';
  const unitText = formatted?.unit ?? null;
  const delta =
    dataState === 'populated' && value !== null
      ? describeDelta({ value, previousValue, unit, favourableDirection, precision: unit === '%' ? 1 : (precision ?? 1) })
      : null;
  const stateCopy =
    explanation ??
    (suppressed
      ? 'Suppressed · fewer than 5 people'
      : belowVolume
        ? `Below evaluation volume${numerator !== undefined && denominator !== undefined ? ` · ${numerator} / ${denominator} required` : ''}`
        : missing
          ? 'No data in this period'
          : null);
  return (
    <section className={cx('flex min-h-[204px] flex-col rounded-lg bg-surface p-5 md:min-w-[208px]', className)}>
      <p className="text-[13px] leading-5 font-medium text-fg-2">{label}</p>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="num text-[28px] leading-9 font-semibold tracking-[-0.02em] text-fg md:text-[32px] md:leading-10">{valueText}</span>
        {unitText && <span className="text-[14px] leading-[22px] text-fg-2">{unitText}</span>}
      </div>

      <div className="mt-2 flex min-h-[32px] items-end justify-between gap-2">
        {delta && delta.direction !== 'none' ? (
          <p
            className={cx(
              'text-[12px] leading-[18px]',
              delta.tone === 'good' && 'text-good',
              delta.tone === 'bad' && 'text-bad',
              delta.tone === 'neutral' && 'text-fg-2',
            )}
          >
            <span className="font-medium">{delta.text}</span>
            {comparisonLabel && <span className="text-muted"> · {comparisonLabel}</span>}
          </p>
        ) : (
          <p className="text-[12px] leading-[18px] text-fg-2">{delta?.text ?? (missing || suppressed || belowVolume ? '' : 'No change')}</p>
        )}
        {dataState === 'populated' && !missing && !belowVolume && !suppressed && sparkline && <Sparkline points={sparkline} />}
      </div>

      {stateCopy && <p className="mt-2 text-[12px] leading-[18px] text-fg-2">{stateCopy}</p>}
      {action && <div className="mt-2">{action}</div>}

      <div className="mt-auto pt-3">
        {period && <p className="text-[12px] leading-[18px] text-muted">{period}</p>}
        {!suppressed && numerator !== undefined && denominator !== undefined && (
          <p className="mt-1 num text-[12px] leading-[18px] text-fg-2">
            {numerator.toLocaleString()} / {denominator.toLocaleString()}
          </p>
        )}
        <p className="mt-1 text-[12px] leading-[18px] text-muted">{freshnessText(updatedAt, staleAfter)}</p>
      </div>
    </section>
  );
}
