import { useRef } from 'react';
import { Alert, Field, LoadingBlock, Select } from '../../ui';
import { dayLabel, type LocalDayPeriod, periodDateLabel } from '../broadcasts/period';
import {
  formatMoment,
  formatWindow,
  hasNoRate,
  isNotFound,
  pctThreshold,
  pointRate,
  STREAMS,
  type StreamKey,
  streamOf,
  type Trend,
  type TrendPoint,
} from './model';
import { ThresholdChart } from './ThresholdChart';

// The trend (#508) is two separate rate charts over the same selected stream. B5 points are
// current statuses over rolling creation windows; low-volume and zero-volume rates are gaps. The
// lines are today's thresholds only — there is no historic pause record to draw.

function rateCell(point: TrendPoint, kind: 'bounce' | 'complaint', minVolume: number): { text: string; withheld: string } {
  const rate = pointRate(point, kind, minVolume);
  return {
    text: rate.value === null ? '—' : `${rate.value.toFixed(2)}%`,
    withheld:
      rate.withheld === 'below-volume'
        ? 'Below evaluation volume'
        : rate.withheld === 'no-volume'
          ? 'No volume'
          : rate.withheld === 'unavailable'
            ? 'Unavailable'
            : '',
  };
}

function latest(points: readonly TrendPoint[], kind: 'bounce' | 'complaint', minVolume: number): string {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (!point) continue;
    const rate = pointRate(point, kind, minVolume);
    if (rate.value !== null) return `${rate.value.toFixed(2)}% on ${dayLabel(point.day)}`;
  }
  return 'none';
}

function gapCount(points: readonly TrendPoint[], kind: 'bounce' | 'complaint', minVolume: number): number {
  return points.filter((point) => pointRate(point, kind, minVolume).value === null).length;
}

function TrendTable({ trend }: { trend: Trend }) {
  return (
    <div className="mt-5 overflow-hidden rounded-lg border border-line bg-surface">
      <section
        className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-md:overflow-visible"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable data table must be reachable with the keyboard to scroll it
        tabIndex={0}
        aria-label="Trend data table; scroll horizontally on narrow screens"
      >
        <table className="w-full border-collapse text-left text-[13px] leading-5 max-md:block">
          <caption className="border-b border-line px-4 py-2.5 text-left text-[12px] leading-[18px] text-muted max-md:block max-md:border-0 max-md:pt-3">
            Recalculated under today’s policy; late status updates can revise earlier points. Lines show current thresholds, not historic
            pause decisions.
          </caption>
          <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted max-md:hidden">
            <tr>
              <th scope="col" className="h-9 px-3 font-medium">
                Day
              </th>
              <th scope="col" className="h-9 px-3 font-medium">
                Window start
              </th>
              <th scope="col" className="h-9 px-3 font-medium">
                Window end
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium">
                Sent
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium">
                Bounced
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium">
                Complained
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium">
                Bounce rate
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium">
                Complaint rate
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium">
                Minimum volume
              </th>
            </tr>
          </thead>
          <tbody className="max-md:block">
            {trend.points.map((point) => {
              const bounce = rateCell(point, 'bounce', trend.thresholds.minVolume);
              const complaint = rateCell(point, 'complaint', trend.thresholds.minVolume);
              return (
                <tr
                  key={point.day}
                  className="border-t border-line align-top max-md:block max-md:border-b max-md:p-3 max-md:last:border-b-0"
                >
                  <th
                    scope="row"
                    className="px-3 py-2.5 text-left font-medium text-fg whitespace-nowrap max-md:flex max-md:justify-between max-md:p-0 max-md:pb-1"
                  >
                    <span>{dayLabel(point.day)}</span>
                    <span className="hidden text-[11px] font-normal text-muted max-md:inline">{point.day}</span>
                  </th>
                  <td
                    data-label="Window start"
                    className="px-3 py-2.5 text-fg-2 whitespace-nowrap max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {formatWindow(point.windowFrom, trend.timeZone)}
                  </td>
                  <td
                    data-label="Window end"
                    className="px-3 py-2.5 text-fg-2 whitespace-nowrap max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {formatWindow(point.windowTo, trend.timeZone)}
                  </td>
                  <td
                    data-label="Sent"
                    className="num px-3 py-2.5 text-right text-fg-2 max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {point.sent.toLocaleString()}
                  </td>
                  <td
                    data-label="Bounced"
                    className="num px-3 py-2.5 text-right text-fg-2 max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {point.bounced.toLocaleString()}
                  </td>
                  <td
                    data-label="Complained"
                    className="num px-3 py-2.5 text-right text-fg-2 max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {point.complained.toLocaleString()}
                  </td>
                  <td
                    data-label="Bounce rate"
                    className="num px-3 py-2.5 text-right text-fg-2 max-md:flex max-md:flex-wrap max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    <span>{bounce.text}</span>
                    {bounce.withheld && <span className="block w-full text-[11px] text-muted">{bounce.withheld}</span>}
                  </td>
                  <td
                    data-label="Complaint rate"
                    className="num px-3 py-2.5 text-right text-fg-2 max-md:flex max-md:flex-wrap max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    <span>{complaint.text}</span>
                    {complaint.withheld && <span className="block w-full text-[11px] text-muted">{complaint.withheld}</span>}
                  </td>
                  <td
                    data-label="Minimum volume"
                    className="num px-3 py-2.5 text-right text-fg-2 max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:py-0.5 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {trend.thresholds.minVolume.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function NotFoundBlock() {
  return (
    <Alert tone="warn" title="This item is not available at this address">
      Return to the deliverability page from the workspace navigation.
    </Alert>
  );
}

export function TrendSection({
  trend,
  loading,
  error,
  onRetry,
  refreshing,
  streamKey,
  onStreamChange,
  period,
  periodChoice,
  onPeriodChange,
}: {
  trend: Trend | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => Promise<void> | void;
  refreshing: boolean;
  streamKey: StreamKey;
  onStreamChange: (key: StreamKey) => void;
  period: LocalDayPeriod;
  periodChoice: 7 | 30;
  onPeriodChange: (choice: 7 | 30) => void;
}) {
  const stream = streamOf(streamKey);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = async () => {
    await onRetry();
    // Retry keeps the person oriented: focus returns to the section heading after the reread.
    queueMicrotask(() => heading.current?.focus());
  };
  const labels = trend?.points.map((point) => dayLabel(point.day)) ?? [];
  const minVolume = trend?.thresholds.minVolume ?? 0;
  const bounceValues = trend?.points.map((point) => pointRate(point, 'bounce', minVolume).value) ?? [];
  const complaintValues = trend?.points.map((point) => pointRate(point, 'complaint', minVolume).value) ?? [];
  const allZero = !!trend && trend.points.length > 0 && trend.points.every((point) => point.sent === 0);

  return (
    <section aria-labelledby="trend-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="trend-heading" ref={heading} tabIndex={-1} className="text-[16px] leading-6 font-semibold outline-none">
            Bounce and complaint trend
          </h2>
          <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
            {stream.label} · {periodDateLabel(period)} · {period.zone} · rates use today’s {trend ? `${trend.windowDays}-day ` : ''}rolling
            creation windows and current statuses.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Period" className="w-[210px]">
            <Select value={periodChoice} onChange={(event) => onPeriodChange(Number(event.target.value) === 7 ? 7 : 30)}>
              <option value={7}>Last 7 complete days</option>
              <option value={30}>Last 30 complete days</option>
            </Select>
          </Field>
          <Field label="Stream" className="w-[210px]">
            <Select value={streamKey} onChange={(event) => onStreamChange(event.target.value as StreamKey)}>
              {STREAMS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {trend ? `Showing ${periodDateLabel(period)} in ${period.zone}.` : ''}
      </p>

      {loading ? (
        <div aria-busy="true">
          <LoadingBlock lines={6} label="Loading the deliverability trend" />
        </div>
      ) : error ? (
        isNotFound(error) ? (
          <NotFoundBlock />
        ) : (
          <Alert tone="bad" title="Couldn’t load the trend" onRetry={() => void retry()}>
            <p>{error}</p>
            <p className="mt-1">Successful health and DNS sections remain visible.</p>
          </Alert>
        )
      ) : !trend || trend.points.length === 0 ? (
        <Alert tone="info" title="No recorded activity in this period">
          Choose another period; missing data is not a healthy result.
        </Alert>
      ) : (
        <div className="space-y-5" aria-busy={refreshing || undefined}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-[18px] text-muted">
            <span>Computed {formatMoment(trend.computedAt)}</span>
            <span>Latest event in period: Unavailable</span>
            <span>Window bounds use {trend.timeZone}</span>
          </div>

          {allZero && (
            <Alert tone="info" title="Zero sends in every window">
              The rates are gaps, not 0%. A zero denominator never proves a healthy stream.
            </Alert>
          )}

          <ThresholdChart
            title={`Bounce rate · last ${trend.points.length} complete days`}
            subtitle={`${stream.label} · bounced ÷ sent · percentages`}
            labels={labels}
            values={bounceValues}
            thresholds={[
              {
                id: 'bounceStop',
                value: trend.thresholds.bounceStop * 100,
                label: `Current stop threshold ${pctThreshold(trend.thresholds.bounceStop)}`,
                tone: 'stop',
                labelPosition: 'above',
              },
            ]}
            summary={`Latest evaluated window: ${latest(trend.points, 'bounce', minVolume)}. Gaps (zero volume or below evaluation volume) in ${gapCount(trend.points, 'bounce', minVolume)} of ${trend.points.length} windows.`}
          />

          <ThresholdChart
            title={`Complaint rate · last ${trend.points.length} complete days`}
            subtitle={`${stream.label} · complained ÷ sent · percentages`}
            labels={labels}
            values={complaintValues}
            thresholds={[
              {
                id: 'complaintStop',
                value: trend.thresholds.complaintStop * 100,
                label: `Stop ≥${pctThreshold(trend.thresholds.complaintStop)}`,
                tone: 'stop',
                labelPosition: 'above',
              },
              {
                id: 'complaintWarn',
                value: trend.thresholds.complaintWarn * 100,
                label: `Warn ≥${pctThreshold(trend.thresholds.complaintWarn)}`,
                tone: 'warn',
                labelPosition: 'below',
              },
            ]}
            summary={`Latest evaluated window: ${latest(trend.points, 'complaint', minVolume)}. Gaps (zero volume or below evaluation volume) in ${gapCount(trend.points, 'complaint', minVolume)} of ${trend.points.length} windows.`}
          />

          {hasNoRate(trend.points, 'bounce', minVolume) && hasNoRate(trend.points, 'complaint', minVolume) && !allZero && (
            <p className="text-[12px] leading-[18px] text-muted">
              No window has an evaluated rate; gaps are zero volume or below evaluation volume, and the table marks each one.
            </p>
          )}

          <TrendTable trend={trend} />

          <p className="text-[12px] leading-[18px] text-muted">
            Minimum volume {trend.thresholds.minVolume.toLocaleString()}. {trend.windowDays}‑day rolling windows ending at each listed
            midnight. Current policy lines; recalculated current statuses, not archived health readings.
          </p>
        </div>
      )}
    </section>
  );
}
