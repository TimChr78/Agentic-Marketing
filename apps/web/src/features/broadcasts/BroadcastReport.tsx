import { useMemo, useState } from 'react';
import { api, type Out } from '../../app/api';
import { TextLink } from '../../app/links';
import { useApi } from '../../app/useApi';
import { measureLabel } from '../../lib/labels';
import { Alert } from '../../ui';
import { KpiTile } from '../../ui/charts';
import { formatDate, formatDateTime } from '../../ui/time';
import { lastSevenLocalDays } from './period';

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
  const delivered = values['email.delivered'];
  const clicked = values['email.clicked'];
  const results = useMemo(() => {
    const endDate = new Date(new Date(period.to).getTime() - 86_400_000);
    return `${formatDate(period.from)} – ${formatDate(endDate.toISOString())} · ${period.zone}`;
  }, [period]);
  const analytics = `/insights/analytics?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}&broadcast=${encodeURIComponent(artifactId)}`;

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
  const noSends = (values['email.sent'] ?? 0) === 0;
  const rateValue = values['email.click_rate'];
  const ratePercent = rateValue === null ? null : Math.round(rateValue * 1000) / 10;
  const hasDelivered = (delivered ?? 0) > 0;
  const rateUnavailable = ratePercent === null || !hasDelivered;
  const tileState = (value: number | null) => (value === null ? (suppressed > 0 ? 'suppressed' : 'no-data') : 'populated');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label={measureLabel('email.sent')}
          value={values['email.sent']}
          unit="count"
          period={`${results} · people`}
          updatedAt={freshness}
          dataState={tileState(values['email.sent'])}
          explanation={values['email.sent'] === null ? 'People count unavailable' : undefined}
        />
        <KpiTile
          label={measureLabel('email.delivered')}
          value={delivered}
          unit="count"
          period={`${results} · people`}
          updatedAt={freshness}
          dataState={tileState(delivered)}
          explanation={delivered === null ? 'People count unavailable' : undefined}
        />
        <KpiTile
          label={measureLabel('email.clicked')}
          value={clicked}
          unit="count"
          period={`${results} · people`}
          updatedAt={freshness}
          dataState={tileState(clicked)}
          explanation={clicked === null ? 'People count unavailable' : undefined}
        />
        <KpiTile
          label={measureLabel('email.click_rate')}
          value={ratePercent}
          unit="%"
          precision={1}
          numerator={hasDelivered ? (clicked ?? undefined) : undefined}
          denominator={hasDelivered ? (delivered ?? undefined) : undefined}
          period={`${results} · clicked ÷ delivered people`}
          updatedAt={freshness}
          dataState={rateUnavailable ? 'no-data' : 'populated'}
          explanation={rateUnavailable ? 'No delivered people to divide by' : undefined}
        />
      </div>
      <p className="text-[12px] leading-[18px] text-muted">
        Latest event in period: {freshness ? formatDateTime(freshness, { zone: true }) : 'not available'}
        {suppressed > 0 ? ` · ${suppressed} ${suppressed === 1 ? 'row' : 'rows'} suppressed below the minimum group size` : ''}
      </p>
      {noSends && (
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
