import { Link } from '../../app/router';
import { measureLabel } from '../../lib/labels';
import { KpiTile } from '../../ui/charts';
import { Alert } from '../../ui/display';
import { HomeSection } from './HomeSection';
import { analyticsHref, type HomePeriod } from './period';
import type { PerformanceBlock, PerformanceResult, Resource } from './useHomeData';

// Four KPI tiles from one current and one previous aggregate (#447). No daily query, no sparkline
// and no new chart props: the values, deltas, suppression and freshness all use KpiTile.

const ORDER = ['email.sent', 'email.delivered', 'email.clicked', 'email.click_rate'] as const;
type Measure = (typeof ORDER)[number];

function measureValue(result: PerformanceResult | null, measure: Measure): number | null {
  if (!result) return null;
  const index = result.columns.findIndex((column) => column.name === measure);
  const row = result.rows[0];
  if (index < 0 || !row) return null;
  const value = row[index];
  return typeof value === 'number' ? value : null;
}

function percent(result: PerformanceResult | null): number | null {
  if (!result) return null;
  const direct = measureValue(result, 'email.click_rate');
  if (direct !== null) return direct * 100;
  const clicked = measureValue(result, 'email.clicked');
  const delivered = measureValue(result, 'email.delivered');
  return clicked !== null && delivered !== null && delivered > 0 ? (clicked / delivered) * 100 : null;
}

function KpiData({ data }: { data: PerformanceBlock }) {
  const { current, previous, previousError } = data;
  const compare = previousError === null && previous !== null;
  const suppressed = current.meta.suppressed > 0;
  const sent = measureValue(current, 'email.sent');
  const delivered = measureValue(current, 'email.delivered');
  const clicked = measureValue(current, 'email.clicked');
  const noSends = sent === 0;
  const noDelivered = delivered === 0;
  // With no sends there is no denominator, even if the metric layer returns a zero ratio.
  const rate = noSends ? null : percent(current);
  const freshness = current.meta.freshness;

  const countExplanation = (value: number | null) =>
    value !== null
      ? noSends
        ? 'No sends in this period'
        : undefined
      : suppressed
        ? 'Suppressed · fewer than 5 people'
        : 'Unavailable in this period';
  const rateExplanation =
    rate === null
      ? suppressed
        ? 'Suppressed · fewer than 5 people'
        : noSends
          ? 'No sends in this period'
          : noDelivered
            ? 'No delivered denominator'
            : 'Unavailable in this period'
      : noSends
        ? 'No sends in this period'
        : undefined;

  const values: Record<Measure, number | null> = {
    'email.sent': sent,
    'email.delivered': delivered,
    'email.clicked': clicked,
    'email.click_rate': rate,
  };

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 lg:gap-4">
      {ORDER.map((measure) => {
        const isRate = measure === 'email.click_rate';
        const value = values[measure];
        const previousValue = compare ? (isRate ? percent(previous) : measureValue(previous, measure)) : null;
        const numerator = isRate && clicked !== null ? clicked : undefined;
        const denominator = isRate && delivered !== null && delivered > 0 ? delivered : undefined;
        return (
          <KpiTile
            key={measure}
            label={measureLabel(measure)}
            value={value}
            unit={isRate ? '%' : 'count'}
            precision={isRate ? 1 : undefined}
            numerator={numerator}
            denominator={denominator}
            previousValue={previousValue}
            comparisonLabel={compare ? 'vs previous 7 days' : undefined}
            favourableDirection={isRate ? 'up' : 'neutral'}
            dataState={value === null ? (suppressed ? 'suppressed' : 'no-data') : 'populated'}
            explanation={isRate ? rateExplanation : countExplanation(value)}
            period={data.period.label}
            updatedAt={freshness}
            className="border border-line"
          />
        );
      })}
    </div>
  );
}

export function HomeKpis({ resource, period, onRetry }: { resource: Resource<PerformanceBlock>; period: HomePeriod; onRetry: () => void }) {
  const range = resource.data?.period ?? period;
  const action = (
    <Link
      to={analyticsHref(range)}
      className="inline-flex min-h-10 items-center text-[13px] leading-5 text-accent hover:underline md:min-h-0"
    >
      Open Analytics
    </Link>
  );
  if (resource.data === undefined && resource.error !== null) {
    return (
      <HomeSection title="E-mail performance" action={action}>
        <div className="p-4 md:p-5">
          <Alert tone="bad" title="Performance unavailable" onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeSection>
    );
  }
  if (resource.data === undefined) {
    return (
      <HomeSection title="E-mail performance" action={action}>
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 md:p-5 lg:grid-cols-4 lg:gap-4">
          {ORDER.map((measure) => (
            <KpiTile key={measure} label={measureLabel(measure)} value={null} dataState="loading" />
          ))}
        </div>
      </HomeSection>
    );
  }
  return (
    <HomeSection title="E-mail performance" action={action}>
      <div className="p-4 md:p-5">
        <KpiData data={resource.data} />
      </div>
    </HomeSection>
  );
}
