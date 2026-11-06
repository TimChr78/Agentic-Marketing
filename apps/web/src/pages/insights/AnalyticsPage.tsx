import { useEffect, useMemo, useState } from 'react';
import { api, type Out } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useApi } from '../../app/useApi';
import { hasBreakdown, TIME_DIMENSIONS } from '../../lib/breakdown';
import {
  ANALYTICS_MEASURES,
  dimensionDescription,
  dimensionLabel,
  METRIC_UNIT_LABEL,
  type MetricUnit,
  measureDescription,
  measureLabel,
  measureUnit,
  metricLabel,
} from '../../lib/labels';
import {
  Alert,
  type ChartSeriesInput,
  Checkbox,
  EmptyState,
  Field,
  Input,
  LineChart,
  LoadingBlock,
  PageHeader,
  Table,
  TableFrame,
  Td,
  THead,
  Th,
  Tr,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

type Result = Out<'analytics.query'>;
type Column = Result['columns'][number];
type MeasureColumn = Column & { index: number };
type TimeDimension = 'day' | 'week' | 'month';

const DEFAULT_MEASURES = ['email.sent', 'email.delivered', 'email.click_rate'];
const UNIT_ORDER: MetricUnit[] = ['count', 'ratio', 'currency'];
const UNIT_TITLE: Record<MetricUnit, string> = {
  count: 'Counts over time',
  ratio: 'Rates over time',
  currency: 'Revenue over time',
};

/** YYYY-MM-DD, for the date inputs. */
const dateInput = (date: Date) => date.toISOString().slice(0, 10);
const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`).toISOString();
const dayEnd = (date: string) => new Date(`${date}T23:59:59.999Z`).toISOString();

/** A ratio is stored as a fraction; every visible rate, chart and table alike, is a percentage. */
const chartValue = (column: Column, value: number | null): number | null => {
  if (value === null) return null;
  return column.unit === 'ratio' ? Math.round(value * 1_000_000) / 10_000 : value;
};

const number = (value: number | string | null, unit?: string, currency?: string | null) => {
  if (value === null || typeof value === 'string') return value ?? '—';
  if (unit === 'ratio') return `${(value * 100).toFixed(2)}%`;
  if (unit === 'currency')
    return currency
      ? value.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 })
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString();
};

/**
 * The same metric layer agents use (#75): pick measures and valid dimensions, choose a range, and
 * read the table or a line chart for a time grain. Counts, rates and money each get their own chart
 * and axis (DESIGN.md → Chart contract), and every measure and dimension is named through the
 * label registry, never by its raw key (#437).
 */
export default function AnalyticsPage() {
  useCrumbs([{ label: 'Analytics' }]);
  const catalog = useApi(() => api.call('analytics.metrics.list', {}), []);
  const [measures, setMeasures] = useState<string[]>(DEFAULT_MEASURES);
  const [dimensions, setDimensions] = useState<string[]>(['day']);
  const [from, setFrom] = useState(dateInput(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(dateInput(new Date()));

  const allowed = useMemo(() => {
    const chosen = (catalog.data?.measures ?? []).filter((m) => measures.includes(m.id));
    if (!chosen.length) return new Set<string>();
    return new Set(chosen[0].dimensions.filter((d) => chosen.every((m) => m.dimensions.includes(d))));
  }, [catalog.data, measures]);

  // A dimension that the new measure set does not allow must not stay selected. Wait for the
  // catalogue so the default "day" is not pruned before any measures are known.
  useEffect(() => {
    if (!catalog.data?.measures.length) return;
    setDimensions((current) => current.filter((d) => allowed.has(d)));
  }, [allowed, catalog.data]);

  const key = `${measures.join(',')}|${dimensions.join(',')}|${from}|${to}`;
  const result = useApi(
    () =>
      api.call('analytics.query', {
        measures,
        dimensions,
        from: dayStart(from),
        to: dayEnd(to),
        limit: 5000,
      }),
    [key],
    { skip: measures.length === 0 },
  );

  const toggleMeasure = (id: string) => {
    setMeasures((current) => {
      if (current.includes(id)) return current.length === 1 ? current : current.filter((m) => m !== id);
      return current.length >= 10 ? current : [...current, id];
    });
  };
  const toggleDimension = (id: string) => {
    if (!allowed.has(id)) return;
    setDimensions((current) => {
      if (current.includes(id)) return current.filter((d) => d !== id);
      return current.length >= 3 ? current : [...current, id];
    });
  };

  const data: Result | undefined = result.data;
  const columns = data?.columns ?? [];
  const timeIndex = columns.findIndex((c) => TIME_DIMENSIONS.has(c.name));
  const timeDimension = timeIndex >= 0 ? (columns[timeIndex].name as TimeDimension) : null;
  const measureColumns: MeasureColumn[] = columns.flatMap((c, index) => (c.kind === 'measure' ? [{ ...c, index }] : []));
  // Counts and rates never share a y-axis: group by the measure's own unit, and keep at most three
  // lines per plot (the table carries every selected measure).
  const groups = UNIT_ORDER.map((unit) => {
    const chosen = measureColumns.filter((m) => m.unit === unit);
    return chosen.length ? { unit, all: chosen.length, columns: chosen.slice(0, 3) } : null;
  }).filter((g): g is { unit: MetricUnit; all: number; columns: MeasureColumn[] } => g !== null);
  // An empty result has no meaningful "newest event": never render the epoch as a date (#438).
  const freshness = data?.rows.length
    ? (() => {
        const at = data?.meta.freshness ? new Date(data.meta.freshness) : null;
        return at && !Number.isNaN(at.getTime()) && at.getFullYear() > 2000 ? at : null;
      })()
    : null;
  const xLabels = (data?.rows ?? []).map((row) => String(row[timeIndex]));
  // A breakdown beside the time grain (Day + Broadcast) returns several rows per day; one line
  // through them would join different broadcasts as if they were one series. Every returned
  // dimension counts, including the `currency` the compiler adds to revenue queries, so Day/USD
  // and Day/EUR are never one line. Until grouped series exist, such a query shows the table only
  // (#442 review).
  const brokenDown = hasBreakdown(columns);

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Analytics"
        description="The read-only metric layer behind the platform and its agents: one catalogue of measures over message, journey and conversion events. Rows smaller than five people are suppressed in breakdowns."
      />

      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mb-2 text-[12px] font-medium text-fg-2">Measures (up to 10)</div>
          {catalog.loading ? (
            <LoadingBlock lines={3} label="Loading measures" />
          ) : catalog.error ? (
            <Alert tone="bad" title="Couldn't load the metric catalogue" onRetry={catalog.reload}>
              {catalog.error}
            </Alert>
          ) : (
            <div className="grid max-h-[190px] gap-x-4 gap-y-1 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
              {(catalog.data?.measures ?? []).map((m) => (
                <Checkbox
                  key={m.id}
                  label={measureLabel(m.id)}
                  title={measureDescription(m.id)}
                  hint={METRIC_UNIT_LABEL[measureUnit(m.id) ?? 'count']}
                  checked={measures.includes(m.id)}
                  onChange={() => toggleMeasure(m.id)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="mb-5 rounded-lg border border-line bg-surface p-3">
        <div className="mb-2 text-[12px] font-medium text-fg-2">Dimensions (up to 3; a time grain makes the chart)</div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(catalog.data?.dimensions ?? []).map((d) => (
            <Checkbox
              key={d.id}
              label={dimensionLabel(d.id)}
              title={dimensionDescription(d.id)}
              hint={d.time ? 'Time grain' : undefined}
              checked={dimensions.includes(d.id)}
              disabled={!allowed.has(d.id)}
              onChange={() => toggleDimension(d.id)}
            />
          ))}
          {!catalog.loading && !allowed.size && <span className="text-[12px] text-warn">Pick a measure to see its dimensions.</span>}
        </div>
      </div>

      {result.error ? (
        <Alert tone="bad" title="Couldn't run the query" onRetry={result.reload} className="mb-5">
          {result.error}
        </Alert>
      ) : timeDimension && brokenDown && (data?.rows.length ?? 0) > 0 ? (
        <p className="mb-5 text-[13px] leading-5 text-muted">
          With a breakdown besides the time grain, the results are in the table below; a chart would join different groups into one line.
        </p>
      ) : timeDimension && (data?.rows.length ?? 0) > 0 ? (
        <div className="mb-5 space-y-8">
          {/* Each chart is an h3; this keeps the page's heading order h1 → h2 → h3. */}
          <h2 className="sr-only">Performance over time</h2>
          {groups.map((group) => {
            const series: ChartSeriesInput[] = group.columns.map((column, index) => ({
              label: measureLabel(column.name),
              values: (data?.rows ?? []).map((row) =>
                chartValue(column, typeof row[column.index] === 'number' ? (row[column.index] as number) : null),
              ),
              viz: index,
            }));
            const names = group.columns.map((c) => measureLabel(c.name)).join(' · ');
            const denominators = [
              ...new Set(group.columns.map((c) => ANALYTICS_MEASURES[c.name]?.denominator).filter((d): d is string => Boolean(d))),
            ];
            const currency = data?.meta.currency ?? 'currency';
            return (
              <div key={group.unit} className="rounded-lg bg-surface p-4 md:p-5">
                <LineChart
                  title={UNIT_TITLE[group.unit]}
                  subtitle={`${names}${denominators.length ? ` · per ${denominators.join(', ')}` : ''} · ${from} to ${to} · ${data?.meta.timeZone}`}
                  labels={xLabels}
                  series={series}
                  unit={group.unit === 'ratio' ? '%' : group.unit === 'currency' ? currency : undefined}
                  formatValue={group.unit === 'currency' ? (value) => number(value, 'currency', data?.meta.currency) : undefined}
                  dataState="populated"
                  note={
                    group.all > group.columns.length
                      ? `Showing the first three ${group.unit === 'ratio' ? 'rates' : group.unit === 'currency' ? 'money measures' : 'counts'} in this plot; the table has all ${group.all}.`
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      ) : null}

      <TableFrame
        loading={result.loading}
        error={null}
        isEmpty={(data?.rows.length ?? 0) === 0}
        columns={Math.max(1, columns.length)}
        empty={
          <EmptyState compact title="No rows for this query">
            Widen the date range, remove a filter, or pick another measure.
          </EmptyState>
        }
        toolbar={
          <span className="text-[12px] text-muted">
            {data ? `${data.rows.length.toLocaleString()} row${data.rows.length === 1 ? '' : 's'}` : 'No result yet'}
            {data?.meta.suppressed ? ` · ${data.meta.suppressed} suppressed (k=${data.meta.k})` : ''}
            {freshness ? ` · newest ${freshness.toLocaleString()}` : ''}
            {data?.meta.currency ? ` · ${data.meta.currency}` : ''}
          </span>
        }
      >
        <Table label="Metric results">
          <THead>
            <tr>
              {columns.map((c) => (
                <Th key={c.name} align={c.kind === 'measure' ? 'right' : undefined}>
                  <span title={measureDescription(c.name) ?? dimensionDescription(c.name)}>{metricLabel(c.name)}</span>
                  {c.kind === 'measure' && c.unit === 'ratio' && <span className="ml-1 text-muted">(%)</span>}
                </Th>
              ))}
            </tr>
          </THead>
          <tbody>
            {(data?.rows ?? []).map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: analytics rows are a read-only result set of positional cells with no id
              <Tr key={i}>
                {columns.map((c, index) => (
                  <Td key={c.name} align={c.kind === 'measure' ? 'right' : undefined}>
                    {c.kind === 'measure'
                      ? number(row[index] as number | null, c.unit, data?.meta.currency)
                      : ((row[index] as string | number | null) ?? '—')}
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>

      {data?.meta.notes.length ? (
        <ul className="mt-3 space-y-1 text-[12px] text-muted">
          {data.meta.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
