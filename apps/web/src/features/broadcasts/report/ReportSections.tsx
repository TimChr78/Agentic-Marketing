import { api } from '../../../app/api';
import { TextLink } from '../../../app/links';
import { useWorkspace } from '../../../app/session';
import { useKeyedApi } from '../../../app/useApi';
import { Alert, BarChart, KpiTile, LineChart } from '../../../ui';
import type { ChartDataState } from '../../../ui/charts';
import { formatDateTime } from '../../../ui/time';
import { type LocalDayPeriod, periodDateLabel, returnedPeriodLabel } from '../period';
import { CampaignHoldoutArea } from './CampaignHoldout';
import {
  type AnalyticsMetaView,
  allTotalsZero,
  deliveryChartState,
  ratePercent,
  rateReason,
  readSeries,
  readTotals,
  SERIES_MEASURES,
  type SeriesView,
  seriesHasValues,
  seriesValues,
  TOTAL_MEASURES,
  type TotalsView,
  tileExplanation,
  tileState,
} from './model';

// The Report tab's sections (#500): four people totals, delivery events, tracked engagement and
// unsubscribes by day, the explicit B4 link-inspection cut, and any campaign-wide holdout.
// Totals and series are independent reads; a failure in one never replaces the other with zeros.

const count = (value: number | null) => (value === null ? '—' : value.toLocaleString());

function SectionMeta({ meta, period, scope }: { meta: AnalyticsMetaView; period: LocalDayPeriod; scope: 'Totals' | 'Series' }) {
  const zone = meta.timeZone ?? period.zone;
  const bounds = returnedPeriodLabel(meta.from, meta.to, zone);
  return (
    <p className="text-[12px] leading-[18px] text-muted">
      {scope} read: {bounds ?? 'Returned period unavailable'} · {zone} · Latest event in period:{' '}
      {meta.freshness ? formatDateTime(meta.freshness, { zone: true }) : 'Unavailable'}
      {meta.suppressed > 0 ? ` · ${meta.suppressed} ${meta.suppressed === 1 ? 'row' : 'rows'} hidden by the k=${meta.k ?? 5} floor` : ''}
    </p>
  );
}

function ChartLegend() {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-full bg-[var(--viz-1)]" />
        Tracked opens
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-sm bg-[var(--viz-2)]" />
        Clicks (dashed)
      </span>
    </span>
  );
}

function TotalsSection({
  view,
  loading,
  error,
  onRetry,
  period,
  showMeta,
}: {
  view: TotalsView;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  period: LocalDayPeriod;
  showMeta: boolean;
}) {
  const values = view.values;
  const suppressed = view.meta.suppressed;
  const periodText = `${periodDateLabel(period)} · ${period.zone} · people`;

  if (loading)
    return (
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
          {['Sent people', 'Delivered people', 'Tracked click rate', 'Unsubscribed people'].map((label) => (
            <KpiTile key={label} label={label} value={null} dataState="loading" />
          ))}
        </div>
        <BarChart
          title="Delivery events · people"
          data={[]}
          ordered
          height={200}
          dataState="loading"
          note="Event counts can overlap and are not a cohort funnel."
        />
      </div>
    );

  if (error)
    return (
      <div className="space-y-4">
        <Alert tone="bad" title="Performance unavailable" onRetry={onRetry}>
          {error}
        </Alert>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {['Sent people', 'Delivered people', 'Tracked click rate', 'Unsubscribed people'].map((label) => (
            <KpiTile
              key={label}
              label={label}
              value={null}
              unit={label === 'Tracked click rate' ? '%' : 'count'}
              period={periodText}
              dataState="no-data"
              explanation="Unavailable"
            />
          ))}
        </div>
        <p className="text-[12px] leading-[18px] text-muted">Charts unavailable until the event read succeeds.</p>
      </div>
    );

  const sent = values['email.sent'];
  const delivered = values['email.delivered'];
  const clicked = values['email.clicked'];
  const unsubscribed = values['email.unsubscribed'];
  const clicks = ratePercent(values['email.click_rate'], delivered);
  const unsubRate = ratePercent(values['email.unsubscribe_rate'], delivered);
  const reason = rateReason({ denominator: delivered, suppressed });
  const unsubExplanation =
    unsubRate === null ? reason : `${unsubRate.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of delivered people`;
  const noEvents = allTotalsZero(view);

  return (
    <div className="space-y-4">
      {showMeta && <SectionMeta meta={view.meta} period={period} scope="Totals" />}
      {noEvents && (
        <Alert tone="info" title="No recorded events in this period">
          Choose another period to inspect this broadcast.
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Sent people"
          value={sent}
          period={periodText}
          updatedAt={view.meta.freshness}
          freshnessLabel="Latest event in period"
          dataState={tileState(sent, suppressed)}
          explanation={tileExplanation(sent, suppressed)}
        />
        <KpiTile
          label="Delivered people"
          value={delivered}
          period={periodText}
          updatedAt={view.meta.freshness}
          freshnessLabel="Latest event in period"
          dataState={tileState(delivered, suppressed)}
          explanation={tileExplanation(delivered, suppressed)}
        />
        <KpiTile
          label="Tracked click rate"
          value={clicks}
          unit="%"
          precision={1}
          numerator={clicks === null ? undefined : (clicked ?? undefined)}
          denominator={clicks === null ? undefined : (delivered ?? undefined)}
          period={`${periodText} · clicked ÷ delivered`}
          updatedAt={view.meta.freshness}
          freshnessLabel="Latest event in period"
          dataState={clicks === null ? tileState(null, suppressed) : 'populated'}
          explanation={clicks === null ? reason : undefined}
        />
        <KpiTile
          label="Unsubscribed people"
          value={unsubscribed}
          numerator={unsubscribed === null ? undefined : unsubscribed}
          denominator={delivered === null ? undefined : delivered}
          period={periodText}
          updatedAt={view.meta.freshness}
          freshnessLabel="Latest event in period"
          dataState={tileState(unsubscribed, suppressed)}
          explanation={
            unsubscribed === null
              ? suppressed > 0
                ? 'Fewer than 5 people'
                : unsubExplanation
              : suppressed > 0
                ? undefined
                : unsubExplanation
          }
        />
      </div>
      <p className="text-[12px] leading-[18px] text-muted">Counts are distinct people in the whole period, not messages.</p>

      <BarChart
        title="Delivery events · people"
        data={[
          { label: 'Sent', value: sent },
          { label: 'Delivered', value: delivered },
          { label: 'Bounced', value: values['email.bounced'] },
          { label: 'Complained', value: values['email.complained'] },
        ]}
        ordered
        height={200}
        formatValue={(value) => (value === null ? '—' : value.toLocaleString())}
        dataState={deliveryChartState(view)}
        stateMessage="No delivery events in this period."
        note="Event counts can overlap and are not a cohort funnel."
        onRetry={onRetry}
      />
    </div>
  );
}

function EngagementSection({
  series,
  totals,
  loading,
  error,
  onRetry,
  period,
  showMeta,
}: {
  series: SeriesView;
  totals: TotalsView;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  period: LocalDayPeriod;
  showMeta: boolean;
}) {
  const labels = series.days.map((day) => day.label);
  const opened = seriesValues(series.days, 'email.opened');
  const clicked = seriesValues(series.days, 'email.clicked');
  const hasEngagement = seriesHasValues(series.days, ['email.opened', 'email.clicked']);
  const hasUnsubscribes = seriesHasValues(series.days, ['email.unsubscribed']);
  const stateOf = (hasValues: boolean): ChartDataState =>
    error ? 'error' : loading ? 'loading' : hasValues ? 'populated' : series.meta.suppressed > 0 ? 'suppressed' : 'no-data';
  const state = stateOf(hasEngagement);
  const unsubscribeState = stateOf(hasUnsubscribes);

  const delivered = totals.values['email.delivered'];
  const openedTotal = totals.values['email.opened'];
  const unsubscribedTotal = totals.values['email.unsubscribed'];
  const openRate = ratePercent(totals.values['email.open_rate'], delivered);
  const openReason = rateReason({ denominator: delivered, suppressed: totals.meta.suppressed });
  const unsubRate = ratePercent(totals.values['email.unsubscribe_rate'], delivered);
  const openSummary =
    openRate === null
      ? `Open rate unavailable · ${openReason}.`
      : `Open rate ${openRate}% · ${count(openedTotal)} opened ÷ ${count(delivered)} delivered.`;
  const unsubscribeSummary =
    unsubRate === null
      ? `${count(unsubscribedTotal)} people in period · rate unavailable`
      : `${count(unsubscribedTotal)} people in period · ${unsubRate}% of delivered people`;
  const totalsReady = !loading && !error && totals.complete;

  return (
    <div className="space-y-5">
      {showMeta && <SectionMeta meta={series.meta} period={period} scope="Series" />}
      <LineChart
        title="Tracked engagement over time"
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <ChartLegend />
            <span>
              {periodDateLabel(period)} · {period.zone} · distinct people by event day
            </span>
          </span>
        }
        summary={totalsReady ? openSummary : undefined}
        note="Daily people; a person may appear on several days. Period totals are deduplicated separately. Tracked engagement; coverage may vary. Zero recorded events does not prove no engagement."
        labels={labels}
        series={[
          { label: 'Tracked opens', values: opened, viz: 0 },
          { label: 'Clicks', values: clicked, viz: 1 },
        ]}
        unit="people"
        height={240}
        dataState={state}
        stateMessage="No chart values available for this period."
        onRetry={onRetry}
      />

      <BarChart
        title="Unsubscribes over time"
        subtitle={totalsReady ? unsubscribeSummary : undefined}
        data={series.days.map((day) => ({ label: day.label, value: day.values['email.unsubscribed'] }))}
        ordered
        maxCategories={31}
        vizIndex={2}
        height={Math.max(200, series.days.length * 22 + 48)}
        formatValue={(value) => (value === null ? '—' : value.toLocaleString())}
        dataState={unsubscribeState}
        stateMessage="No unsubscribe events in this period."
        note="Daily people by event day; the period count above is deduplicated separately."
        onRetry={onRetry}
      />
    </div>
  );
}

function LinkInspection({ canReadProfiles }: { canReadProfiles: boolean }) {
  return (
    <Alert tone="info" title="Top links unavailable">
      <p>Safe link labels are not available for this report.</p>
      {canReadProfiles && (
        <p className="mt-1">
          <TextLink to="/insights/messages">Open Message activity</TextLink>
        </p>
      )}
    </Alert>
  );
}

export function ReportBody({ artifactId, period }: { artifactId: string; period: LocalDayPeriod }) {
  const { can } = useWorkspace();
  // Artifact and period are the identity of the report; a new selection never shows the
  // previous period's totals under its label.
  const reportKey = `${artifactId}|${period.from}|${period.to}`;
  const totalsQuery = useKeyedApi(reportKey, () =>
    api.call('analytics.query', {
      measures: [...TOTAL_MEASURES],
      dimensions: [],
      from: period.from,
      to: period.to,
      filters: { broadcast: artifactId },
    }),
  );
  const seriesQuery = useKeyedApi(reportKey, () =>
    api.call('analytics.query', {
      measures: [...SERIES_MEASURES],
      dimensions: ['day'],
      from: period.from,
      to: period.to,
      filters: { broadcast: artifactId },
    }),
  );
  const totals = readTotals(totalsQuery.data);
  const series = readSeries(seriesQuery.data, period);

  return (
    <div className="space-y-5">
      <TotalsSection
        view={totals}
        loading={totalsQuery.loading}
        error={totalsQuery.error}
        onRetry={totalsQuery.reload}
        period={period}
        showMeta={!!totalsQuery.data && !totalsQuery.error}
      />
      <EngagementSection
        series={series}
        totals={totals}
        loading={seriesQuery.loading}
        error={seriesQuery.error}
        onRetry={seriesQuery.reload}
        period={period}
        showMeta={!!seriesQuery.data && !seriesQuery.error}
      />
      <LinkInspection canReadProfiles={can('profiles:read')} />
      <CampaignHoldoutArea artifactId={artifactId} period={period} />
    </div>
  );
}
