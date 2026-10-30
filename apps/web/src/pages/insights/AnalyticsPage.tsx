import { useEffect, useMemo, useState } from 'react';
import { api, type Out } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useApi } from '../../app/useApi';
import { Chart } from '../../components/Chart';
import { Alert, Checkbox, EmptyState, Field, Input, LoadingBlock, PageHeader, Table, TableFrame, Td, THead, Th, Tr } from '../../ui';
import { pageWidth } from '../../ui/layout';

type Result = Out<'analytics.query'>;
type TimeDimension = 'day' | 'week' | 'month';

const TIME_DIMENSIONS = new Set(['day', 'week', 'month']);
const DEFAULT_MEASURES = ['email.sent', 'email.delivered', 'email.click_rate'];

/** YYYY-MM-DD, for the date inputs. */
const dateInput = (date: Date) => date.toISOString().slice(0, 10);
const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`).toISOString();
const dayEnd = (date: string) => new Date(`${date}T23:59:59.999Z`).toISOString();

const number = (value: number | string | null, unit?: string) => {
  if (value === null || typeof value === 'string') return value ?? '—';
  if (unit === 'ratio') return `${(value * 100).toFixed(2)}%`;
  if (unit === 'currency') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString();
};

/**
 * The same metric layer agents use (#75): pick measures and valid dimensions, choose a range, and
 * read the table or a line chart for a time grain. No mock data and no client-side aggregation.
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
  const measureColumns = columns.flatMap((c, index) => (c.kind === 'measure' ? [{ ...c, index }] : []));

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
                  label={m.id}
                  hint={m.unit === 'ratio' ? 'rate' : m.unit}
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
              label={d.id}
              hint={d.time ? 'time' : undefined}
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
      ) : timeDimension && measureColumns.length > 0 && (data?.rows.length ?? 0) > 0 ? (
        <div className="mb-5 rounded-lg border border-line bg-surface p-3">
          <div className="mb-1 px-1 text-[12px] text-muted">
            {timeDimension} · {data?.meta.timeZone}
          </div>
          <Chart
            deps={[data]}
            height={280}
            option={(c) => ({
              legend: { top: 0, right: 8, textStyle: { color: c.muted }, itemWidth: 12, itemHeight: 8 },
              grid: { left: 8, right: 20, top: 30, bottom: 4, containLabel: true },
              tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.line, textStyle: { color: c.fg } },
              xAxis: {
                type: 'category',
                data: (data?.rows ?? []).map((r) => String(r[timeIndex])),
                axisLine: { lineStyle: { color: c.line } },
                axisTick: { show: false },
              },
              yAxis: { type: 'value', splitLine: { lineStyle: { color: c.line } } },
              series: measureColumns.map((m, i) => ({
                name: m.name,
                type: 'line',
                smooth: true,
                symbol: 'none',
                connectNulls: false,
                data: (data?.rows ?? []).map((r) => (typeof r[m.index] === 'number' ? (r[m.index] as number) : null)),
                lineStyle: { width: 2, color: [c.accent, c.good, c.agent, c.bad][i % 4] },
                itemStyle: { color: [c.accent, c.good, c.agent, c.bad][i % 4] },
              })),
            })}
          />
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
            {data?.meta.freshness ? ` · newest ${new Date(data.meta.freshness).toLocaleString()}` : ''}
            {data?.meta.currency ? ` · ${data.meta.currency}` : ''}
          </span>
        }
      >
        <Table label="Metric results">
          <THead>
            <tr>
              {columns.map((c) => (
                <Th key={c.name} align={c.kind === 'measure' ? 'right' : undefined}>
                  {c.name}
                </Th>
              ))}
            </tr>
          </THead>
          <tbody>
            {(data?.rows ?? []).map((row, i) => (
              <Tr key={i}>
                {columns.map((c, index) => (
                  <Td key={c.name} align={c.kind === 'measure' ? 'right' : undefined}>
                    {c.kind === 'measure' ? number(row[index], c.unit) : (row[index] ?? '—')}
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
