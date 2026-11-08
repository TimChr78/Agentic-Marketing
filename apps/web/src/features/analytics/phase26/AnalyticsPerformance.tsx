import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../app/api';
import { setSearchParam, useLocation } from '../../../app/router';
import { useSession } from '../../../app/session';
import { useApi, useKeyedApi } from '../../../app/useApi';
import { ANALYTICS_MEASURES, METRIC_UNIT_LABEL, measureDescription, measureLabel, measureUnit } from '../../../lib/labels';
import { analyticsParams } from '../../../pages/insights/analyticsParams';
import {
  Alert,
  Button,
  ChartSkeleton,
  Checkbox,
  Field,
  Input,
  KpiSkeleton,
  LineChart,
  ListSkeleton,
  PageHeader,
  Select,
} from '../../../ui';
import type { ChartDataState, ChartSeriesInput } from '../../../ui/charts';
import { pageWidth } from '../../../ui/layout';
import { getWorkspaceTimeZone } from '../../../ui/time';
import {
  type AnalyticsSource,
  CONVERSION_MEASURES,
  MAX_MEASURES,
  MEASURE_GROUPS,
  measureGroupOf,
  PRESET_ORDER,
  PRESETS,
  type PresetId,
  presetForGroup,
  resolveMeasures,
  selectionForMeasures,
  toggleMeasureSelection,
} from './definitions';
import {
  allObservedZero,
  countComparison,
  formatCount,
  formatMeasure,
  formatMoney,
  formatPercent,
  type MetaView,
  metaOf,
  REVENUE_UNAVAILABLE,
  rateComparison,
  ratioPercent,
  readSeries,
  readTotals,
  revenueGate,
  type SeriesView,
  seriesHasValues,
  zeroPriorVisible,
} from './model';
import { completeDayRange, dateTimeLabelIn, periodDateLabel, previousRange, rangeFromDates } from './period';
import { queryInput } from './queries';

type Selection = { preset: PresetId | 'conversion'; source: AnalyticsSource; measures: string[] };
type PeriodChoice = '7' | '30' | 'custom';

interface Initial {
  selection: Selection;
  range: ReturnType<typeof completeDayRange>;
  priorRange: ReturnType<typeof previousRange>;
  periodChoice: PeriodChoice;
  broadcast: string | null;
  invalid: string[];
  notice: string | null;
}

function initialise(search: URLSearchParams, zone: string): Initial {
  const parsed = analyticsParams(search);
  const hasRange = search.get('from') !== null || search.get('to') !== null;
  const rangeInvalid = parsed.invalid.includes('from/to');
  const range =
    hasRange && !rangeInvalid ? rangeFromDates(parsed.params.from, parsed.params.to, zone) : completeDayRange(7, new Date(), zone);

  const hasMeasures = search.get('measures') !== null;
  const measuresInvalid = parsed.invalid.includes('measures');
  const linkMeasures = hasMeasures && !measuresInvalid ? parsed.params.measures : PRESETS.newsletter.measures;
  const inferred =
    hasMeasures && !measuresInvalid
      ? selectionForMeasures(linkMeasures)
      : { preset: 'newsletter' as const, source: 'message_events' as const };
  // A link may name a measure this page's groups do not offer, or measures from two sources. Pick
  // one question's defaults instead of sending a mixed-source query.
  const linkIsUsable = linkMeasures.every((id) => measureGroupOf(id)?.source === inferred.source);
  const fallbackMeasures =
    inferred.preset === 'conversion'
      ? (MEASURE_GROUPS.find((group) => group.id === 'conversion')?.measures ?? [])
      : PRESETS[inferred.preset].measures;
  const measures = linkIsUsable ? linkMeasures : fallbackMeasures;
  const { preset, source } = inferred;

  const notices: string[] = [];
  if (hasMeasures && !measuresInvalid && !linkIsUsable) {
    notices.push('Some linked measures are not part of one question here; the default selection is shown instead.');
  }
  if (search.get('dimensions') !== null && parsed.params.dimensions.some((dimension) => dimension !== 'day')) {
    notices.push('Breakdowns are not available in this report; the chart and table use daily results.');
  }

  let broadcast = parsed.params.broadcast;
  if (broadcast && source !== 'message_events') {
    broadcast = null;
    notices.push('Broadcast filter removed: the selected question does not support it.');
  }

  return {
    selection: { preset, source, measures: resolveMeasures(measures) },
    range,
    priorRange: previousRange(range),
    periodChoice: hasRange && !rangeInvalid ? 'custom' : '7',
    broadcast,
    invalid: parsed.invalid,
    notice: notices.length ? notices.join(' ') : null,
  };
}

function MetaLine({
  range,
  priorRange,
  meta,
  compare,
}: {
  range: ReturnType<typeof completeDayRange>;
  priorRange: ReturnType<typeof previousRange>;
  meta: MetaView;
  compare: boolean;
}) {
  return (
    <p className="text-[12px] leading-[18px] text-muted" data-testid="analytics-period">
      {periodDateLabel(range)} · {range.zone} · Latest event in period: {dateTimeLabelIn(meta.freshness, range.zone) ?? 'Unavailable'}
      {compare ? ` · Previous period: ${periodDateLabel(priorRange)}` : ''}
    </p>
  );
}

function Tile({
  label,
  value,
  unit,
  comparison,
  explanation,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit?: string;
  comparison?: string;
  explanation?: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  return (
    <section className="flex min-h-[204px] flex-col rounded-lg bg-surface p-5">
      <p className="text-[13px] leading-5 font-medium text-fg-2">{label}</p>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="num text-[28px] leading-9 font-semibold tracking-[-0.02em] text-fg md:text-[32px] md:leading-10">{value}</span>
        {unit && <span className="text-[14px] leading-[22px] text-fg-2">{unit}</span>}
      </div>
      {comparison && (
        <p
          className={
            tone === 'good'
              ? 'mt-2 text-[12px] leading-[18px] text-good'
              : tone === 'bad'
                ? 'mt-2 text-[12px] leading-[18px] text-bad'
                : 'mt-2 text-[12px] leading-[18px] text-fg-2'
          }
        >
          {comparison}
        </p>
      )}
      {explanation && <p className="mt-auto pt-2 text-[12px] leading-[18px] text-muted">{explanation}</p>}
    </section>
  );
}

const LOADING_TILES: Record<Selection['preset'], string[]> = {
  newsletter: ['Delivered people', 'Tracked click rate', 'Unsubscribed people', 'Open rate · tracked'],
  journey: ['Entered', 'Goal reached', 'Goal/entry ratio'],
  deliverability: ['Bounce rate', 'Complaint rate', 'Sent people'],
  conversion: ['Conversions', 'Revenue'],
};

function SkeletonBlock({ label, preset }: { label: string; preset: Selection['preset'] }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {LOADING_TILES[preset].map((name) => (
          <KpiSkeleton key={name} label={name} />
        ))}
      </div>
      <ChartSkeleton label={`${label} chart`} />
      <ListSkeleton label={`${label} table`} rows={5} columns={4} />
    </div>
  );
}

function chartState(input: { error: string | null; loading: boolean; hasValues: boolean; suppressed: number }): ChartDataState {
  if (input.error) return 'error';
  if (input.loading) return 'loading';
  if (input.hasValues) return 'populated';
  return input.suppressed > 0 ? 'suppressed' : 'no-data';
}

function priorLookup(series: SeriesView): Map<string, SeriesView['tableRows'][number]> {
  const map = new Map<string, SeriesView['tableRows'][number]>();
  for (const row of series.tableRows) map.set(`${row.day}|${row.currency ?? ''}`, row);
  return map;
}

/**
 * Analytics performance (#506): fixed questions, a grouped measure picker, the chart before the
 * table and a comparison with the immediately preceding equal period. Reads are per period, not
 * per row, and the AI usage tab remains the page's other tab.
 */
export default function AnalyticsPerformance() {
  const { search } = useLocation();
  const { can } = useSession();
  const canRead = can('artifacts:read');
  const zone = getWorkspaceTimeZone();
  const [initial] = useState(() => initialise(search, zone));
  const [selection, setSelection] = useState<Selection>(initial.selection);
  const [range, setRange] = useState(initial.range);
  const [periodChoice, setPeriodChoice] = useState<PeriodChoice>(initial.periodChoice);
  const [compare, setCompare] = useState(true);
  const [broadcast, setBroadcast] = useState<string | null>(initial.broadcast);
  const [notice, setNotice] = useState<string | null>(initial.notice);
  const [announcement, setAnnouncement] = useState('');
  const [customFrom, setCustomFrom] = useState(initial.range.fromDate);
  const [customTo, setCustomTo] = useState(initial.range.toDate);
  const periodRef = useRef<HTMLSelectElement | null>(null);

  // The catalogue is one read per mount, never per chart; refresh reuses it.
  const catalogue = useApi(() => api.call('analytics.metrics.list', {}), [], { skip: !canRead });
  const catalogueById = useMemo(() => new Map((catalogue.data?.measures ?? []).map((measure) => [measure.id, measure])), [catalogue.data]);

  const measureGroups = useMemo(
    () =>
      MEASURE_GROUPS.map((group) => ({
        ...group,
        entries: group.measures
          .filter((id) => !catalogue.data || catalogueById.has(id))
          .map((id) => {
            const fromCatalogue = catalogueById.get(id);
            const unit = fromCatalogue?.unit ?? measureUnit(id) ?? ANALYTICS_MEASURES[id]?.unit ?? 'count';
            return {
              id,
              label: measureLabel(id),
              description: fromCatalogue?.description ?? measureDescription(id),
              unit: METRIC_UNIT_LABEL[unit],
            };
          }),
      })),
    [catalogue.data, catalogueById],
  );

  const measures = selection.measures;
  const resolvedMeasures = useMemo(() => resolveMeasures(measures), [measures]);
  const priorRange = useMemo(() => previousRange(range), [range]);
  const conversion = selection.source === 'events';
  const filters = broadcast ? { broadcast } : undefined;
  const readKey = `${resolvedMeasures.join(',')}|${range.from}|${range.to}|${broadcast ?? ''}|${conversion}`;
  const priorKey = `${priorRange.from}|${priorRange.to}`;
  const priorReadKey = `${readKey}|prior:${priorKey}`;
  const enabled = canRead && resolvedMeasures.length > 0;

  // Hook order matters for the contract's read budget: catalogue, current totals, prior totals,
  // prior series, current series. Current series is last so the latest read is the selected period.
  // Each result is keyed to the question, measures and bounds it belongs to, so a pending read for
  // a new selection never leaves older values under the new label.
  const currentTotals = useKeyedApi(
    readKey,
    () => api.call('analytics.query', queryInput({ measures: resolvedMeasures, range, kind: 'totals', filters, conversion })),
    { skip: !enabled },
  );
  const priorTotals = useKeyedApi(
    priorReadKey,
    () => api.call('analytics.query', queryInput({ measures: resolvedMeasures, range: priorRange, kind: 'totals', filters, conversion })),
    { skip: !enabled || !compare },
  );
  const priorSeries = useKeyedApi(
    priorReadKey,
    () => api.call('analytics.query', queryInput({ measures: resolvedMeasures, range: priorRange, kind: 'series', filters, conversion })),
    { skip: !enabled || !compare },
  );
  const currentSeries = useKeyedApi(
    readKey,
    () => api.call('analytics.query', queryInput({ measures: resolvedMeasures, range, kind: 'series', filters, conversion })),
    { skip: !enabled },
  );

  useEffect(() => {
    if (selection.source !== 'message_events' && broadcast) {
      setBroadcast(null);
      setSearchParam('broadcast', null);
      setNotice('Broadcast filter removed: the selected question does not support it.');
      setAnnouncement('Broadcast filter removed.');
    }
  }, [selection.source, broadcast]);

  if (!canRead) {
    return (
      <div className={pageWidth('default')}>
        <PageHeader title="Analytics" description="What changed in your newsletter results?" />
        <Alert tone="info" title="Restricted by your role">
          Restricted by your role. No protected reads were made. Ask a workspace administrator for access.
        </Alert>
      </div>
    );
  }

  const announce = (message: string) => setAnnouncement(message);

  const resetBroadcast = (reason: string) => {
    if (!broadcast) return;
    setBroadcast(null);
    setSearchParam('broadcast', null);
    setNotice(reason);
    setAnnouncement('Broadcast filter removed.');
  };

  const choosePreset = (id: PresetId) => {
    const preset = PRESETS[id];
    setSelection({ preset: id, source: preset.source, measures: [...preset.measures] });
    announce(`${preset.label} selected. ${preset.measures.length} measures.`);
    if (preset.source !== 'message_events') resetBroadcast('Broadcast filter removed: the selected question does not support it.');
  };

  const toggleMeasure = (id: string) => {
    const group = measureGroupOf(id);
    if (!group) return;
    if (group.source !== selection.source) {
      const preset = presetForGroup(group);
      setSelection({ preset, source: group.source, measures: [...group.defaults] });
      announce(`${group.label} selected; measures replaced with ${group.defaults.map(measureLabel).join(', ')}.`);
      if (group.source !== 'message_events') resetBroadcast('Broadcast filter removed: the selected question does not support it.');
      return;
    }
    const next = toggleMeasureSelection(selection.measures, id);
    if ('error' in next) {
      announce(
        next.error === 'cap'
          ? `At most ${MAX_MEASURES} measures including ratio bases; nothing was added.`
          : 'Keep at least one measure selected.',
      );
      return;
    }
    setSelection((current) => ({ ...current, measures: next.measures }));
    announce(`${measureLabel(id)} ${next.measures.includes(id) ? 'added' : 'removed'}.`);
  };

  const choosePeriod = (value: PeriodChoice) => {
    setPeriodChoice(value);
    if (value === 'custom') {
      setCustomFrom(range.fromDate);
      setCustomTo(range.toDate);
      return;
    }
    const next = completeDayRange(Number(value) as 7 | 30, new Date(), zone);
    setRange(next);
    setCustomFrom(next.fromDate);
    setCustomTo(next.toDate);
    setSearchParam('from', null);
    setSearchParam('to', null);
    announce('Period changed.');
  };

  const applyCustomRange = (fromDate: string, toDate: string) => {
    setCustomFrom(fromDate);
    setCustomTo(toDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) return;
    setRange(rangeFromDates(fromDate, toDate, zone));
    setSearchParam('from', fromDate);
    setSearchParam('to', toDate);
    announce('Custom period applied.');
  };

  const refresh = () => {
    // Remove current-value claims from the old result before the new read lands (#506).
    currentTotals.setData(undefined);
    currentSeries.setData(undefined);
    currentTotals.reload();
    currentSeries.reload();
    if (compare) {
      priorTotals.setData(undefined);
      priorSeries.setData(undefined);
      priorTotals.reload();
      priorSeries.reload();
    }
    announce('Report refreshed.');
  };

  const retryFailed = () => {
    if (catalogue.error) catalogue.reload();
    if (currentTotals.error) currentTotals.reload();
    if (currentSeries.error) currentSeries.reload();
    if (compare && priorTotals.error) priorTotals.reload();
    if (compare && priorSeries.error) priorSeries.reload();
  };

  const totals = readTotals(currentTotals.error ? undefined : currentTotals.data, resolvedMeasures);
  const prior = readTotals(priorTotals.error ? undefined : priorTotals.data, resolvedMeasures);
  const series = readSeries(currentSeries.error ? undefined : currentSeries.data, range, resolvedMeasures);
  const priorSeriesView = readSeries(priorSeries.error ? undefined : priorSeries.data, priorRange, resolvedMeasures);
  const metaSource =
    !currentTotals.error && currentTotals.data ? currentTotals.data : !currentSeries.error ? currentSeries.data : undefined;
  const meta = metaOf(metaSource);
  const loading = currentTotals.loading || currentSeries.loading || (compare && (priorTotals.loading || priorSeries.loading));
  const failed = [
    currentTotals.error ? 'totals' : null,
    currentSeries.error ? 'series' : null,
    compare && priorTotals.error ? 'prior totals' : null,
    compare && priorSeries.error ? 'prior series' : null,
  ].filter((value): value is string => Boolean(value));
  const anySuccess = Boolean(currentTotals.data || currentSeries.data);
  const notFound =
    failed.length > 0 &&
    [currentTotals.error, currentSeries.error, priorTotals.error, priorSeries.error].some(
      (error) => !!error && /not[_ ]?found|404/i.test(error),
    );

  const hasSeries = seriesHasValues(series.days, resolvedMeasures);
  const observedZero = allObservedZero(totals, resolvedMeasures);
  const isEmpty = !loading && !currentTotals.error && !currentSeries.error && !totals.complete && !hasSeries;
  const priorZero = compare && resolvedMeasures.some((id) => zeroPriorVisible(totals.values[id], prior.values[id]));

  const currency = meta.currency;
  const suppressed = Math.max(
    meta.suppressed,
    series.meta.suppressed,
    compare ? prior.meta.suppressed : 0,
    compare ? priorSeriesView.meta.suppressed : 0,
  );
  const suppressedK = series.meta.k ?? meta.k ?? 5;
  const currentCurrencies = Object.keys(totals.revenueByCurrency).length
    ? Object.keys(totals.revenueByCurrency)
    : [...new Set(series.days.flatMap((day) => day.currencies))];
  const priorCurrencies = Object.keys(prior.revenueByCurrency).length
    ? Object.keys(prior.revenueByCurrency)
    : [...new Set(priorSeriesView.days.flatMap((day) => day.currencies))];
  const gate = revenueGate({
    currentMeta: meta,
    currentCurrencies,
    priorMeta: compare ? prior.meta : null,
    priorCurrencies,
    comparing: compare,
  });
  const conversionSelected = resolvedMeasures.includes('revenue');

  const chartMeasures = (() => {
    if (selection.preset === 'conversion') return CONVERSION_MEASURES.filter((id) => measures.includes(id));
    const preset = PRESETS[selection.preset];
    const extra = measures.filter((id) => !preset.measures.includes(id));
    return [...new Set([...preset.chart.filter((id) => measures.includes(id)), ...extra])];
  })();

  const chartNote = conversionSelected
    ? 'Conversions count distinct events; revenue sums the values by their own currency.'
    : PRESETS[selection.preset === 'conversion' ? 'newsletter' : selection.preset].note;

  const priorMap = priorLookup(priorSeriesView);

  const renderTiles = () => {
    const tile = (id: string) => ({
      label: measureLabel(id),
      value: formatMeasure(totals.values[id], id, currency),
      unit: measureUnit(id) === 'ratio' ? '%' : undefined,
    });

    const delivered = totals.values['email.delivered'];
    const clicked = totals.values['email.clicked'];
    const unsubscribed = totals.values['email.unsubscribed'];
    const opened = totals.values['email.opened'];
    const sent = totals.values['email.sent'];
    const bounced = totals.values['email.bounced'];
    const complained = totals.values['email.complained'];
    const entered = totals.values['journey.entered'];
    const goal = totals.values['journey.goal_reached'];

    if (selection.preset === 'journey') {
      const ratio = ratioPercent(goal, entered);
      return (
        <>
          <Tile
            label={tile('journey.entered').label}
            value={tile('journey.entered').value}
            comparison={compare ? countComparison(entered, prior.values['journey.entered'], formatCount, 'up').text : undefined}
            tone={compare ? countComparison(entered, prior.values['journey.entered'], formatCount, 'up').tone : 'neutral'}
            explanation={entered === null ? 'Unavailable in this period' : 'Distinct participants who entered'}
          />
          <Tile
            label={tile('journey.goal_reached').label}
            value={tile('journey.goal_reached').value}
            comparison={compare ? countComparison(goal, prior.values['journey.goal_reached'], formatCount, 'up').text : undefined}
            tone={compare ? countComparison(goal, prior.values['journey.goal_reached'], formatCount, 'up').tone : 'neutral'}
            explanation={goal === null ? 'Unavailable in this period' : 'Distinct participants who reached the goal'}
          />
          <Tile
            label="Goal/entry ratio"
            value={ratio === null ? '—' : `${ratio.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
            explanation="Event-period ratio, not a cohort funnel. It can exceed 100%."
          />
        </>
      );
    }

    if (selection.preset === 'deliverability') {
      return (
        <>
          <Tile
            label={tile('email.bounce_rate').label}
            value={tile('email.bounce_rate').value}
            comparison={
              compare
                ? rateComparison(totals.values['email.bounce_rate'], prior.values['email.bounce_rate'], formatPercent, 'down').text
                : undefined
            }
            tone={
              compare
                ? rateComparison(totals.values['email.bounce_rate'], prior.values['email.bounce_rate'], formatPercent, 'down').tone
                : 'neutral'
            }
            explanation={`${formatCount(bounced)} bounced / ${formatCount(sent)} sent`}
          />
          <Tile
            label={tile('email.complaint_rate').label}
            value={tile('email.complaint_rate').value}
            comparison={
              compare
                ? rateComparison(totals.values['email.complaint_rate'], prior.values['email.complaint_rate'], formatPercent, 'down').text
                : undefined
            }
            tone={
              compare
                ? rateComparison(totals.values['email.complaint_rate'], prior.values['email.complaint_rate'], formatPercent, 'down').tone
                : 'neutral'
            }
            explanation={`${formatCount(complained)} complained / ${formatCount(sent)} sent`}
          />
          <Tile
            label="Sent people"
            value={formatCount(sent)}
            comparison={compare ? countComparison(sent, prior.values['email.sent'], formatCount, 'up').text : undefined}
            tone={compare ? countComparison(sent, prior.values['email.sent'], formatCount, 'up').tone : 'neutral'}
            explanation="Distinct people sent in the period"
          />
        </>
      );
    }

    if (selection.preset === 'conversion') {
      return (
        <>
          <Tile
            label="Conversions"
            value={formatCount(totals.values.conversions)}
            comparison={compare ? countComparison(totals.values.conversions, prior.values.conversions, formatCount, 'up').text : undefined}
            tone={compare ? countComparison(totals.values.conversions, prior.values.conversions, formatCount, 'up').tone : 'neutral'}
            explanation="Distinct conversion events in the period"
          />
          <Tile
            label="Revenue"
            value={gate.ok ? formatMoney(totals.values.revenue, gate.currency) : '—'}
            comparison={
              gate.ok && compare
                ? countComparison(totals.values.revenue, prior.values.revenue, (value) => formatMoney(value, gate.currency), 'up').text
                : undefined
            }
            tone={
              gate.ok && compare
                ? countComparison(totals.values.revenue, prior.values.revenue, (value) => formatMoney(value, gate.currency), 'up').tone
                : 'neutral'
            }
            explanation={gate.ok ? `Sum of conversion values in ${gate.currency}` : 'Revenue unavailable for this result'}
          />
        </>
      );
    }

    return (
      <>
        <Tile
          label="Delivered people"
          value={formatCount(delivered)}
          comparison={compare ? countComparison(delivered, prior.values['email.delivered'], formatCount, 'up').text : undefined}
          tone={compare ? countComparison(delivered, prior.values['email.delivered'], formatCount, 'up').tone : 'neutral'}
          explanation={delivered === null ? 'Unavailable in this period' : 'Distinct people whose e-mail was delivered'}
        />
        <Tile
          label="Tracked click rate"
          value={formatPercent(totals.values['email.click_rate'])}
          comparison={
            compare
              ? rateComparison(totals.values['email.click_rate'], prior.values['email.click_rate'], formatPercent, 'up').text
              : undefined
          }
          tone={
            compare
              ? rateComparison(totals.values['email.click_rate'], prior.values['email.click_rate'], formatPercent, 'up').tone
              : 'neutral'
          }
          explanation={`${formatCount(clicked)} clicked / ${formatCount(delivered)} delivered`}
        />
        <Tile
          label="Unsubscribed people"
          value={formatCount(unsubscribed)}
          comparison={compare ? countComparison(unsubscribed, prior.values['email.unsubscribed'], formatCount, 'down').text : undefined}
          tone={compare ? countComparison(unsubscribed, prior.values['email.unsubscribed'], formatCount, 'down').tone : 'neutral'}
          explanation={`${formatCount(unsubscribed)} / ${formatCount(delivered)} delivered = ${formatPercent(totals.values['email.unsubscribe_rate'])}`}
        />
        <Tile
          label="Open rate · tracked"
          value={formatPercent(totals.values['email.open_rate'])}
          comparison={
            compare
              ? rateComparison(totals.values['email.open_rate'], prior.values['email.open_rate'], formatPercent, 'up').text
              : undefined
          }
          tone={
            compare
              ? rateComparison(totals.values['email.open_rate'], prior.values['email.open_rate'], formatPercent, 'up').tone
              : 'neutral'
          }
          explanation={`${formatCount(opened)} opened / ${formatCount(delivered)} delivered`}
        />
      </>
    );
  };

  const renderCharts = () => {
    if (!chartMeasures.length) return null;
    return (
      <section className="space-y-5" aria-labelledby="analytics-charts-heading">
        <h2 id="analytics-charts-heading" className="sr-only">
          Charts
        </h2>
        {chartMeasures.map((id) => {
          const unit = measureUnit(id);
          if (canRead && conversionSelected && unit === 'currency' && !gate.ok) {
            return (
              <div key={id} className="rounded-lg bg-surface p-5">
                <Alert tone="info" title="Revenue chart unavailable">
                  {REVENUE_UNAVAILABLE}
                </Alert>
                <p className="mt-2 text-[12px] leading-[18px] text-muted">
                  Amounts remain separate and are shown in the table below. Currency comparison and combined target progress are
                  unavailable.
                </p>
              </div>
            );
          }
          const values = series.days.map((day) =>
            unit === 'ratio' && day.values[id] !== null ? Math.round(day.values[id]! * 100_000) / 1000 : day.values[id],
          );
          const reported = series.days.map((day) => day.values[id]);
          const priorValues = compare
            ? priorSeriesView.days.map((day) =>
                unit === 'ratio' && day.values[id] !== null ? Math.round(day.values[id]! * 100_000) / 1000 : day.values[id],
              )
            : [];
          const hasValues = reported.some((value) => value !== null);
          const state = chartState({
            error: currentSeries.error,
            loading: currentSeries.loading,
            hasValues,
            suppressed: series.meta.suppressed,
          });
          const inputSeries: ChartSeriesInput[] = [{ label: measureLabel(id), values, viz: 0 }];
          if (compare) inputSeries.push({ label: `${measureLabel(id)} · Previous period`, values: priorValues, viz: 1, dashed: true });
          const currencyCode = gate.ok ? gate.currency : null;
          const formatValue = (value: number | null) =>
            unit === 'ratio'
              ? value === null
                ? '—'
                : `${value.toLocaleString()}%`
              : unit === 'currency'
                ? formatMoney(value, currencyCode)
                : value === null
                  ? '—'
                  : value.toLocaleString();
          const subtitle = `${periodDateLabel(range)} · ${range.zone}${compare ? ` · Previous period ${periodDateLabel(priorRange)} aligned by day` : ''}${
            unit === 'ratio' ? ` · per ${id.includes('bounce') || id.includes('complaint') ? 'sent people' : 'delivered people'}` : ''
          }`;
          const total = totals.values[id];
          const summary =
            unit === 'ratio'
              ? `${measureLabel(id)} ${formatPercent(total)} in the period.`
              : unit === 'currency'
                ? `${measureLabel(id)} ${formatMoney(total, currencyCode)} in the period.`
                : `${formatCount(total)} ${unit === 'count' ? (conversionSelected ? 'events' : 'people') : ''} in the period.`;
          return (
            <div key={id} className="rounded-lg bg-surface p-5">
              <LineChart
                title={`${measureLabel(id)} over time`}
                subtitle={subtitle}
                summary={summary}
                labels={series.days.map((day) => day.label)}
                series={inputSeries}
                unit={unit === 'ratio' ? '%' : unit === 'currency' ? (currencyCode ?? undefined) : conversionSelected ? 'events' : 'people'}
                formatValue={formatValue}
                dataState={state}
                stateMessage={
                  state === 'suppressed'
                    ? `Values unavailable — fewer than ${series.meta.k ?? 5} people. The server suppressed this breakdown.`
                    : state === 'no-data'
                      ? 'No recorded activity in this period.'
                      : 'Performance unavailable. Retry.'
                }
                onRetry={currentSeries.reload}
                note={chartNote}
                height={240}
              />
            </div>
          );
        })}
      </section>
    );
  };

  const renderTable = () => {
    if (loading) {
      return (
        <ListSkeleton
          label="Loading the result table"
          rows={Math.max(1, series.days.length)}
          columns={resolvedMeasures.length * (compare ? 2 : 1) + (conversionSelected ? 1 : 0) + 1}
        />
      );
    }
    if (currentSeries.error && !currentSeries.data) {
      return (
        <Alert tone="bad" title="Result table unavailable" onRetry={currentSeries.reload}>
          Performance unavailable. Retry.
        </Alert>
      );
    }
    return (
      <section aria-labelledby="analytics-table-heading" className="rounded-lg bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 id="analytics-table-heading" className="text-[16px] leading-6 font-semibold">
            Result table
          </h2>
          <span className="text-[12px] text-muted">
            {series.tableRows.length.toLocaleString()} row{series.tableRows.length === 1 ? '' : 's'}
            {suppressed > 0 ? ` · ${suppressed} suppressed (k=${suppressedK})` : ''}
            {currency ? ` · ${currency}` : ''}
          </span>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable table must be reachable by keyboard (axe scrollable-region-focusable). */}
        <section className="overflow-x-auto" aria-label="Analytics results, scrollable" tabIndex={0}>
          <table aria-label="Analytics results" className="w-full border-collapse text-left text-[13px] leading-5">
            <caption className="sr-only">
              {periodDateLabel(range)} in {range.zone}
              {compare ? `, compared with ${periodDateLabel(priorRange)}` : ''}. Daily unique people are not added to period totals.
            </caption>
            <thead className="bg-surface-2 text-muted max-md:hidden">
              <tr>
                <th scope="col" className="h-9 px-3 font-medium whitespace-nowrap md:px-4">
                  Day
                </th>
                {conversionSelected && (
                  <th scope="col" className="h-9 px-3 font-medium whitespace-nowrap md:px-4">
                    Currency
                  </th>
                )}
                {resolvedMeasures.map((id) => (
                  <th key={`${id}-current`} scope="col" className="h-9 px-3 text-right font-medium whitespace-nowrap md:px-4">
                    {measureLabel(id)} (current)
                  </th>
                ))}
                {compare &&
                  resolvedMeasures.map((id) => (
                    <th key={`${id}-prior`} scope="col" className="h-9 px-3 text-right font-medium whitespace-nowrap md:px-4">
                      {measureLabel(id)} (previous)
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {series.tableRows.map((row) => {
                const index = series.days.findIndex((day) => day.day === row.day);
                const priorDay = priorSeriesView.days[index];
                const priorRow =
                  priorMap.get(`${row.day}|${row.currency ?? ''}`) ??
                  (priorDay ? priorMap.get(`${priorDay.day}|${row.currency ?? ''}`) : undefined);
                const dayText = compare ? `${row.label} / ${priorDay?.label ?? '—'}` : row.label;
                return (
                  <tr key={row.key} className="max-md:block max-md:border-t max-md:border-line">
                    <th
                      scope="row"
                      className="border-t border-line px-3 py-2 text-left font-normal text-fg-2 max-md:flex max-md:justify-between max-md:border-0 md:px-4"
                    >
                      <span className="text-muted md:hidden">Day: </span>
                      {dayText}
                    </th>
                    {conversionSelected && (
                      <td className="border-t border-line px-3 py-2 text-fg-2 max-md:flex max-md:justify-between max-md:border-0 md:px-4">
                        <span className="text-muted md:hidden">Currency: </span>
                        {row.currency ?? 'Unavailable'}
                      </td>
                    )}
                    {resolvedMeasures.map((id) => {
                      const value = formatMeasure(row.values[id] ?? null, id, row.currency);
                      return (
                        <td
                          key={`${row.key}-${id}`}
                          className="num border-t border-line px-3 py-2 text-right text-fg-2 max-md:flex max-md:justify-between max-md:border-0 max-md:text-left md:px-4"
                          aria-label={`${measureLabel(id)} ${value}`}
                        >
                          <span className="text-muted md:hidden">{measureLabel(id)}: </span>
                          {value}
                        </td>
                      );
                    })}
                    {compare &&
                      resolvedMeasures.map((id) => {
                        const value = priorRow ? formatMeasure(priorRow.values[id] ?? null, id, priorRow.currency) : '—';
                        return (
                          <td
                            key={`${row.key}-${id}-prior`}
                            className="num border-t border-line px-3 py-2 text-right text-fg-2 max-md:flex max-md:justify-between max-md:border-0 max-md:text-left md:px-4"
                            aria-label={`${measureLabel(id)} previous ${value}`}
                          >
                            <span className="text-muted md:hidden">Previous {measureLabel(id)}: </span>
                            {value}
                          </td>
                        );
                      })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        {!series.tableRows.length && <p className="px-4 py-4 text-[13px] text-muted">No rows for this period.</p>}
        <p className="border-t border-line px-4 py-2 text-[12px] leading-[18px] text-muted">
          Daily unique people are not added to period totals.
          {compare ? ` Previous period: ${periodDateLabel(priorRange)}, ${priorRange.zone}.` : ''}
        </p>
      </section>
    );
  };

  return (
    <div className={pageWidth('default')}>
      <PageHeader title="Analytics" description="What changed in your newsletter results?" />

      {initial.invalid.length > 0 && (
        <Alert tone="info" className="mb-5">
          This link had an invalid {initial.invalid.join(', ')} value; the available defaults are shown instead.
        </Alert>
      )}
      {notice && (
        <Alert
          tone="info"
          className="mb-5"
          action={
            <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          }
        >
          {notice}
        </Alert>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Question" className="min-w-[220px] flex-1">
              <Select value={selection.preset} onChange={(event) => choosePreset(event.target.value as PresetId)}>
                {PRESET_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {PRESETS[id].label}
                  </option>
                ))}
                {selection.preset === 'conversion' && <option value="conversion">Conversion value</option>}
              </Select>
            </Field>
            <label className="flex min-h-10 items-center gap-2 pb-1 text-[13px] text-fg-2">
              <input
                type="checkbox"
                className="size-5 rounded-sm border-control accent-[var(--accent)] md:size-4"
                checked={compare}
                onChange={(event) => {
                  setCompare(event.target.checked);
                  announce(event.target.checked ? 'Comparison on.' : 'Comparison off.');
                }}
              />
              Compare previous period
            </label>
          </div>

          <details className="mt-3">
            <summary className="flex min-h-10 cursor-pointer items-center text-[13px] font-medium text-accent">Choose measures</summary>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              {measureGroups.map((group) => (
                <fieldset key={group.id} className="min-w-0">
                  <legend className="mb-1 text-[12px] font-medium text-fg-2">{group.label}</legend>
                  <p className="mb-1 text-[12px] leading-[18px] text-muted">{group.hint}</p>
                  <div className="space-y-1.5">
                    {group.entries.map((entry) => (
                      <Checkbox
                        key={entry.id}
                        label={entry.label}
                        title={entry.description}
                        hint={entry.unit}
                        checked={selection.measures.includes(entry.id)}
                        onChange={() => toggleMeasure(entry.id)}
                      />
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
            <p className="mt-2 text-[12px] leading-[18px] text-muted">
              At most {MAX_MEASURES} measures including ratio bases. A rate always carries its numerator and denominator.
            </p>
            {catalogue.loading && <p className="mt-2 text-[12px] text-muted">Loading the metric catalogue…</p>}
            {catalogue.error && (
              <Alert tone="bad" title="Couldn't load the metric catalogue" onRetry={catalogue.reload} className="mt-2">
                {catalogue.error}
              </Alert>
            )}
          </details>
        </div>

        <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
          <Field label="Period">
            <Select ref={periodRef} value={periodChoice} onChange={(event) => choosePeriod(event.target.value as PeriodChoice)}>
              <option value="7">Last 7 complete days</option>
              <option value="30">Last 30 complete days</option>
              {periodChoice === 'custom' && <option value="custom">Custom range</option>}
            </Select>
          </Field>
          {periodChoice === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="From">
                <Input type="date" value={customFrom} onChange={(event) => applyCustomRange(event.target.value, customTo)} />
              </Field>
              <Field label="To">
                <Input type="date" value={customTo} onChange={(event) => applyCustomRange(customFrom, event.target.value)} />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={refresh}>
              Refresh
            </Button>
            {broadcast && (
              <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-0.5 pr-1 pl-2.5 text-[12px] text-fg-2">
                <span>Broadcast filter</span>
                <span className="max-w-[140px] truncate font-mono text-[11px]">{broadcast}</span>
                <button
                  type="button"
                  aria-label="Remove broadcast filter"
                  onClick={() => {
                    setBroadcast(null);
                    setSearchParam('broadcast', null);
                    announce('Broadcast filter removed.');
                  }}
                  className="inline-flex size-6 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg"
                >
                  ×
                </button>
              </span>
            )}
          </div>
        </div>
      </div>

      <MetaLine range={range} priorRange={priorRange} meta={meta} compare={compare} />

      {notFound ? (
        <Alert tone="info" className="mt-4" title="This item is not available at this address">
          Return to the list.
        </Alert>
      ) : (
        <>
          {failed.length > 0 && anySuccess && !loading && (
            <Alert tone="warn" className="mt-4" title="One section could not load" onRetry={retryFailed}>
              Other successful sections remain available.
            </Alert>
          )}
          {failed.length > 0 && !anySuccess && !loading && (
            <Alert tone="bad" className="mt-4" title="Couldn’t load analytics" onRetry={retryFailed}>
              No old values are shown as current.
            </Alert>
          )}
          {suppressed > 0 && (
            <Alert tone="info" className="mt-4" title="Values unavailable — fewer than 5 people">
              The server suppressed this breakdown (k={suppressedK}); no identities or inferred values are shown.
            </Alert>
          )}
          {observedZero && (
            <Alert tone="info" className="mt-4" title="Zero recorded events">
              Zero recorded events does not prove no engagement. Latest event in period: Unavailable.
            </Alert>
          )}
          {!observedZero && priorZero && compare && (
            <Alert tone="info" className="mt-4" title="Previous period returned 0">
              Relative change unavailable; absolute counts remain visible.
            </Alert>
          )}

          {loading ? (
            <div className="mt-4">
              <SkeletonBlock label="Loading analytics" preset={selection.preset} />
            </div>
          ) : isEmpty ? (
            <Alert tone="info" className="mt-4" title="No recorded activity in this period">
              Choose another period; missing data is not a healthy result.
              <div className="mt-2">
                <Button size="sm" variant="secondary" onClick={() => periodRef.current?.focus()}>
                  Change period
                </Button>
              </div>
            </Alert>
          ) : failed.length > 0 && !anySuccess ? null : (
            <div className="mt-4 space-y-6">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{renderTiles()}</div>
              {renderCharts()}
              {renderTable()}
              {(meta.notes.length > 0 || prior.meta.notes.length > 0) && (
                <ul className="space-y-1 text-[12px] leading-[18px] text-muted">
                  {[...new Set([...meta.notes, ...(compare ? prior.meta.notes : [])])].map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
