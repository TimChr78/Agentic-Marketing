import { useMemo, useState } from 'react';
import { api, type Out } from '../../app/api';
import { TextLink } from '../../app/links';
import { useApi } from '../../app/useApi';
import { measureLabel } from '../../lib/labels';
import { Alert } from '../../ui';
import { KpiTile } from '../../ui/charts';
import { formatDate, formatDateTime } from '../../ui/time';
import { analyticsHrefFor, lastSevenLocalDays } from './period';

// The Phase 24 report (#448): a minimal existing-read summary, not the Phase 25 link ranking. Four
// KpiTile primitives for the last seven complete local days, with people semantics from the label
// registry and the query metadata. Message event counts stay in the Sending tab, labelled messages.

type Result = Out<'analytics.query'>;

const COLUMNS = ['email.sent', 'email.delivered', 'email.clicked', 'email.click_rate'] as const;

function valuesOf(result: Result | undefined): Record<(typeof COLUMNS)[number], number | null> {
  const out = Object.fromEntries(COLUMNS.map((id) => [id, null])) as Record<(typeof COLUMNS)[number], number | null>;
  if (!result?.rows.length) return out;
  const row = result.rows[0]!;
  for (const id of COLUMNS) {
    const index = result.columns.findIndex((column) => column.name === id);
    const value = index >= 0 ? row[index] : null;
    out[id] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return out;
}

export interface BroadcastReportView {
  /** Only an observed zero (not a suppressed or unavailable null) means no sends. */
  noSends: boolean;
  ratePercent: number | null;
  rateAvailable: boolean;
  rateExplanation?: string;
  rateDataState: 'populated' | 'suppressed' | 'no-data';
  /** Why a count tile is null: suppressed or simply unavailable, never "No sends". */
  countExplanation: (value: number | null) => string | undefined;
}

/** The four tiles' shared semantics, so a suppressed or missing value is never shown as zero. */
export function reportViewOf(values: Record<(typeof COLUMNS)[number], number | null>, suppressed: number): BroadcastReportView {
  const sent = values['email.sent'];
  const delivered = values['email.delivered'];
  const rateValue = values['email.click_rate'];
  const noSends = sent === 0;
  const ratePercent = rateValue === null ? null : Math.round(rateValue * 1000) / 10;
  const hasDelivered = delivered !== null && delivered > 0;
  const rateAvailable = ratePercent !== null && hasDelivered;

  let rateExplanation: string | undefined;
  if (!rateAvailable) {
    if (suppressed > 0) rateExplanation = 'Suppressed · fewer than 5 people';
    else if (noSends) rateExplanation = 'No sends in this period';
    else if (delivered === 0) rateExplanation = 'No delivered people to divide by';
    else rateExplanation = 'Unavailable in this period';
  }

  return {
    noSends,
    ratePercent,
    rateAvailable,
    rateExplanation,
    rateDataState: rateAvailable ? 'populated' : suppressed > 0 ? 'suppressed' : 'no-data',
    countExplanation: (value) =>
      value !== null
        ? noSends
          ? 'No sends in this period'
          : undefined
        : suppressed > 0
          ? 'Suppressed · fewer than 5 people'
          : 'Unavailable in this period',
  };
}

/** A count tile is populated only for an observed number; null is suppressed or unavailable. */
const tileState = (value: number | null, suppressed: number) =>
  value === null ? (suppressed > 0 ? 'suppressed' : 'no-data') : 'populated';

export function BroadcastReport({ artifactId, active }: { artifactId: string; active: boolean }) {
  const [period] = useState(() => lastSevenLocalDays());
  const query = useApi(
    () =>
      api.call('analytics.query', {
        measures: [...COLUMNS],
        dimensions: [],
        from: period.from,
        to: period.to,
        filters: { broadcast: artifactId },
      }),
    [artifactId, period.from, period.to],
    { skip: !active },
  );

  const values = useMemo(() => valuesOf(query.data), [query.data]);
  const results = useMemo(() => {
    const endDate = new Date(new Date(period.to).getTime() - 86_400_000);
    return `${formatDate(period.from)} – ${formatDate(endDate.toISOString())} · ${period.zone}`;
  }, [period]);
  const analytics = analyticsHrefFor(period, artifactId);

  if (query.loading)
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
        {COLUMNS.map((id) => (
          <KpiTile key={id} label={measureLabel(id)} value={null} dataState="loading" />
        ))}
      </div>
    );

  if (query.error)
    return (
      <Alert tone="bad" title="Performance unavailable" onRetry={query.reload}>
        {query.error}
      </Alert>
    );

  const meta = query.data?.meta;
  const suppressed = meta?.suppressed ?? 0;
  const freshness = meta?.freshness && new Date(meta.freshness).getFullYear() >= 2000 ? meta.freshness : null;
  const view = reportViewOf(values, suppressed);
  const delivered = values['email.delivered'];
  const clicked = values['email.clicked'];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label={measureLabel('email.sent')}
          value={values['email.sent']}
          unit="count"
          period={`${results} · people`}
          updatedAt={freshness}
          dataState={tileState(values['email.sent'], suppressed)}
          explanation={view.countExplanation(values['email.sent'])}
        />
        <KpiTile
          label={measureLabel('email.delivered')}
          value={delivered}
          unit="count"
          period={`${results} · people`}
          updatedAt={freshness}
          dataState={tileState(delivered, suppressed)}
          explanation={view.countExplanation(delivered)}
        />
        <KpiTile
          label={measureLabel('email.clicked')}
          value={clicked}
          unit="count"
          period={`${results} · people`}
          updatedAt={freshness}
          dataState={tileState(clicked, suppressed)}
          explanation={view.countExplanation(clicked)}
        />
        <KpiTile
          label={measureLabel('email.click_rate')}
          value={view.ratePercent}
          unit="%"
          precision={1}
          numerator={view.rateAvailable ? (clicked ?? undefined) : undefined}
          denominator={view.rateAvailable ? (delivered ?? undefined) : undefined}
          period={`${results} · clicked ÷ delivered people`}
          updatedAt={freshness}
          dataState={view.rateDataState}
          explanation={view.rateExplanation}
        />
      </div>
      <p className="text-[12px] leading-[18px] text-muted">
        Latest event in period: {freshness ? formatDateTime(freshness, { zone: true }) : 'not available'}
        {suppressed > 0 ? ` · ${suppressed} ${suppressed === 1 ? 'row' : 'rows'} suppressed below the minimum group size` : ''}
      </p>
      {view.noSends && (
        <Alert
          tone="info"
          title="No sends in this period"
          action={
            <TextLink to={analytics} className="text-[13px]">
              Change the period in Analytics
            </TextLink>
          }
        >
          This broadcast has no sent messages in the last seven complete local days.
        </Alert>
      )}
      <p className="text-[12px] leading-[18px] text-muted">
        Counts are distinct people in the whole period, not messages.{' '}
        <TextLink to={analytics} className="text-[12px]">
          Open in Analytics
        </TextLink>
      </p>
    </div>
  );
}
