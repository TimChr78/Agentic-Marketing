import { Alert, StatusPill } from '../../ui';
import {
  type Health,
  pctThreshold,
  ratesOf,
  rateView,
  STREAMS,
  type StreamKey,
  streamOf,
  streamVerdict,
  type WithheldReason,
} from './model';

// Delivery health (#508): four streams, each with the raw sample, the policy's evaluation minimum,
// both rates with their own thresholds, and the server's status. A rate below the minimum volume is
// an em dash, never a healthy-looking 0%.

function rateText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

function withheldText(withheld: WithheldReason): string {
  switch (withheld) {
    case 'below-volume':
      return 'Below evaluation volume';
    case 'no-volume':
      return 'No denominator available';
    case 'unavailable':
      return 'Unavailable';
    default:
      return '';
  }
}

function StreamTable({ health }: { health: Health }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-left text-[13px] leading-5 max-md:block">
        <caption className="sr-only">
          Delivery health for {STREAMS.length} streams over rolling {health.windowDays}-day windows with today’s thresholds.
        </caption>
        <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted max-md:hidden">
          <tr>
            <th scope="col" className="h-9 px-4 font-medium">
              Stream
            </th>
            <th scope="col" className="h-9 px-4 text-right font-medium">
              Sent
            </th>
            <th scope="col" className="h-9 px-4 text-right font-medium">
              Sample
            </th>
            <th scope="col" className="h-9 px-4 text-right font-medium">
              Bounce rate
            </th>
            <th scope="col" className="h-9 px-4 text-right font-medium">
              Complaint rate
            </th>
            <th scope="col" className="h-9 px-4 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="max-md:block">
          {STREAMS.map((stream) => {
            const rates = ratesOf(health, stream.key);
            const verdict = streamVerdict(rates, health.thresholds, {
              windowDays: health.windowDays,
              marketing: stream.marketing,
              autoPause: health.autoPause,
            });
            const bounce = rateView(rates.sent, health.thresholds.minVolume, rates.bounceRate);
            const complaint = rateView(rates.sent, health.thresholds.minVolume, rates.complaintRate);
            return (
              <tr
                key={stream.key}
                className="border-t border-line align-top max-md:block max-md:border-b max-md:p-4 max-md:last:border-b-0"
              >
                <th
                  scope="row"
                  className="px-4 py-3 text-left font-medium text-fg max-md:flex max-md:flex-wrap max-md:items-center max-md:justify-between max-md:gap-2 max-md:p-0"
                >
                  <span>{stream.label}</span>
                </th>
                <td
                  data-label="Sent"
                  className="num px-4 py-3 text-right text-fg-2 max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:pt-2 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                >
                  {rates.sent.toLocaleString()}
                </td>
                <td
                  data-label="Sample"
                  className="num px-4 py-3 text-right text-fg-2 max-md:flex max-md:justify-between max-md:gap-3 max-md:p-0 max-md:pt-1 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                >
                  {rates.sent.toLocaleString()} / minimum {health.thresholds.minVolume.toLocaleString()}
                </td>
                <td
                  data-label="Bounce rate"
                  className="num px-4 py-3 text-right text-fg-2 max-md:flex max-md:flex-wrap max-md:justify-between max-md:gap-3 max-md:p-0 max-md:pt-1 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                >
                  <span className="block w-full text-right">{rateText(bounce.value)}</span>
                  <span className="block w-full text-[12px] leading-[18px] text-muted">
                    {bounce.value === null
                      ? withheldText(bounce.withheld)
                      : `${rates.bounced.toLocaleString()} / ${rates.sent.toLocaleString()} sent · stop ≥${pctThreshold(health.thresholds.bounceStop)}`}
                  </span>
                </td>
                <td
                  data-label="Complaint rate"
                  className="num px-4 py-3 text-right text-fg-2 max-md:flex max-md:flex-wrap max-md:justify-between max-md:gap-3 max-md:p-0 max-md:pt-1 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                >
                  <span className="block w-full text-right">{rateText(complaint.value)}</span>
                  <span className="block w-full text-[12px] leading-[18px] text-muted">
                    {complaint.value === null
                      ? withheldText(complaint.withheld)
                      : `${rates.complained.toLocaleString()} / ${rates.sent.toLocaleString()} sent · warn ≥${pctThreshold(health.thresholds.complaintWarn)} · stop ≥${pctThreshold(health.thresholds.complaintStop)}`}
                  </span>
                </td>
                <td data-label="Status" className="px-4 py-3 max-md:block max-md:p-0 max-md:pt-2">
                  <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
                  <p className="mt-1 max-w-[260px] text-[12px] leading-[18px] text-muted">{verdict.detail}</p>
                  {verdict.reason && <p className="mt-1 max-w-[260px] text-[12px] leading-[18px] text-warn">{verdict.reason}</p>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MetricTile({
  label,
  value,
  meta,
  note,
  windowDays,
}: {
  label: string;
  value: string;
  meta: string;
  note?: string;
  windowDays: number;
}) {
  return (
    <section aria-label={label} className="flex min-h-[204px] min-w-0 flex-col rounded-lg bg-surface p-5 md:min-w-[208px]">
      <p className="text-[13px] leading-5 font-medium text-fg-2">{label}</p>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="num text-[28px] leading-9 font-semibold tracking-[-0.02em] text-fg md:text-[32px] md:leading-10">{value}</span>
      </div>
      <p className="mt-2 text-[12px] leading-[18px] text-fg-2">{meta}</p>
      {note && <p className="mt-1 text-[12px] leading-[18px] text-muted">{note}</p>}
      <p className="mt-auto pt-3 text-[12px] leading-[18px] text-muted">Current statuses · rolling {windowDays} days</p>
    </section>
  );
}

export function SelectedStreamTiles({
  health,
  streamKey,
  onRefresh,
  refreshing,
}: {
  health: Health;
  streamKey: StreamKey;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const stream = streamOf(streamKey);
  const rates = ratesOf(health, streamKey);
  const verdict = streamVerdict(rates, health.thresholds, {
    windowDays: health.windowDays,
    marketing: stream.marketing,
    autoPause: health.autoPause,
  });
  const bounce = rateView(rates.sent, health.thresholds.minVolume, rates.bounceRate);
  const complaint = rateView(rates.sent, health.thresholds.minVolume, rates.complaintRate);
  const sample = `${rates.sent.toLocaleString()} / minimum ${health.thresholds.minVolume.toLocaleString()}`;

  return (
    <section aria-labelledby="selected-stream-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="selected-stream-heading" className="text-[16px] leading-6 font-semibold">
            Selected stream · {stream.label}
          </h2>
          <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
            Raw sample, both rates and the threshold that decided the state. Latest event in period: Unavailable.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex h-10 items-center rounded-md border border-control bg-surface px-3 text-[13px] font-medium text-fg hover:border-fg-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-muted md:h-8"
          >
            {refreshing ? 'Refreshing…' : 'Refresh rates'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          windowDays={health.windowDays}
          label={`Sent messages · rolling ${health.windowDays} days`}
          value={rates.sent.toLocaleString()}
          meta={`Sample ${sample}`}
          note="Bounced + complained are included in sent."
        />
        <MetricTile
          windowDays={health.windowDays}
          label="Bounce rate"
          value={bounce.value === null ? '—' : rateText(bounce.value)}
          meta={
            bounce.value === null
              ? withheldText(bounce.withheld)
              : `${rates.bounced.toLocaleString()} / ${rates.sent.toLocaleString()} sent · stop ≥${pctThreshold(health.thresholds.bounceStop)}`
          }
          note={bounce.value === null ? 'Not evaluated; no healthy claim.' : undefined}
        />
        <MetricTile
          windowDays={health.windowDays}
          label="Complaint rate"
          value={complaint.value === null ? '—' : rateText(complaint.value)}
          meta={
            complaint.value === null
              ? withheldText(complaint.withheld)
              : `${rates.complained.toLocaleString()} / ${rates.sent.toLocaleString()} sent · warn ≥${pctThreshold(health.thresholds.complaintWarn)} · stop ≥${pctThreshold(health.thresholds.complaintStop)}`
          }
          note={complaint.value === null ? 'Not evaluated; no healthy claim.' : undefined}
        />
        <MetricTile
          windowDays={health.windowDays}
          label="Auto-pause"
          value={health.autoPause ? 'On' : 'Off'}
          meta={`${health.autoPause ? 'Marketing only' : 'Warnings only'} · stop complaints ≥${pctThreshold(health.thresholds.complaintStop)}`}
          note={
            health.autoPause
              ? 'Paused marketing resumes only after the rate falls or policy changes.'
              : 'Stop thresholds warn only; no stream is paused automatically.'
          }
        />
      </div>
      <p className="text-[12px] leading-[18px] text-muted">
        Today’s thresholds only. This operational read has no k-suppression field; missing values stay unavailable and no suppression
        threshold is invented.
      </p>
    </section>
  );
}

export function StreamHealthSection({ health }: { health: Health }) {
  const empty = STREAMS.every((stream) => ratesOf(health, stream.key).sent <= 0);
  return (
    <section aria-labelledby="health-heading" className="space-y-3">
      <div>
        <h2 id="health-heading" className="text-[16px] leading-6 font-semibold">
          Delivery health · rolling {health.windowDays} days
        </h2>
        <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
          Sent = sent + delivered + bounced + complained, counted by message and creation time, never unique people. Rates use today’s
          evaluation minimum of {health.thresholds.minVolume.toLocaleString()} messages.
        </p>
      </div>
      {empty && (
        <Alert tone="info" title="No recorded activity in this period">
          No stream has a recorded send in the rolling window. Missing data is not a healthy result; choose another period when the
          workspace has activity.
        </Alert>
      )}
      <StreamTable health={health} />
      <p className="text-[12px] leading-[18px] text-muted">
        Latest event in period: Unavailable. The three reads that build this page do not return an event timestamp.
      </p>
    </section>
  );
}
