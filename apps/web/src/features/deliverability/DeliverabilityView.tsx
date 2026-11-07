import { type ReactNode, useRef, useState } from 'react';
import { api } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi, useKeyedApi } from '../../app/useApi';
import { Alert, Card, EmptyState, LoadingBlock } from '../../ui';
import { type ReportPeriodChoice, reportPeriod } from '../broadcasts/period';
import { DnsSection } from './DnsCards';
import { cleanSelectors, isNotFound, type StreamKey, sameSelectors, streamOf } from './model';
import { SelectedStreamTiles, StreamHealthSection } from './StreamHealth';
import { TrendSection } from './TrendSection';

// The page's one read budget (#508): health once, domains once and the selected stream's trend once
// on mount. A stream or period change reloads only the trend; Check DNS reloads only the domains;
// Refresh rates reloads health and trend. Nothing is fetched per stream or per domain.

function SectionError({ title, error, onRetry, children }: { title: string; error: string; onRetry: () => void; children?: ReactNode }) {
  if (isNotFound(error)) {
    return (
      <Alert tone="warn" title="This item is not available at this address">
        Return to the deliverability page from the workspace navigation.
      </Alert>
    );
  }
  return (
    <Alert tone="bad" title={title} onRetry={onRetry}>
      <p>{error}</p>
      {children && <p className="mt-1">{children}</p>}
    </Alert>
  );
}

function LoadingSection({ label, lines }: { label: string; lines: number }) {
  return (
    <Card>
      <div aria-busy="true">
        <LoadingBlock lines={lines} label={label} />
      </div>
    </Card>
  );
}

export function DeliverabilityView() {
  const { can } = useSession();
  const canRead = can('artifacts:read');
  const admin = can('workspace:admin');

  const [streamKey, setStreamKey] = useState<StreamKey>('email.marketing');
  const [periodChoice, setPeriodChoice] = useState<ReportPeriodChoice>(30);
  const [period, setPeriod] = useState(() => reportPeriod(30));
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectors, setSelectors] = useState('');
  const [appliedSelectors, setAppliedSelectors] = useState<string[]>([]);
  const [dnsKey, setDnsKey] = useState(0);
  const healthHeading = useRef<HTMLHeadingElement>(null);

  const health = useApi(() => api.call('deliverability.health', {}), [refreshKey], { skip: !canRead });
  const stream = streamOf(streamKey);
  // The trend belongs to the exact bounds and stream it was requested for. Until that read lands,
  // a previously selected stream's points must not sit under the new stream's label.
  const trendKey = `${period.from}|${period.nextMidnight}|${streamKey}|${refreshKey}`;
  const trend = useKeyedApi(
    trendKey,
    () =>
      api.call('deliverability.trend', {
        from: period.from,
        to: period.nextMidnight,
        channel: stream.channel,
        stream: stream.stream,
      }),
    { skip: !canRead },
  );
  const domains = useApi(() => api.call('sendingDomains.list', { dkimSelectors: appliedSelectors }), [appliedSelectors, dnsKey], {
    skip: !canRead,
  });

  if (!canRead) {
    return (
      <Card>
        <EmptyState title="Restricted by your role">
          No protected reads were made. Ask a workspace administrator for access to artifacts and deliverability.
        </EmptyState>
      </Card>
    );
  }

  const refreshing = health.refreshing || trend.refreshing;
  const refresh = () => {
    // A fresh period anchor keeps a refresh from reusing bounds that have crossed a local midnight.
    setPeriod(reportPeriod(periodChoice));
    setRefreshKey((value) => value + 1);
  };
  const changePeriod = (choice: ReportPeriodChoice) => {
    setPeriodChoice(choice);
    setPeriod(reportPeriod(choice));
  };
  const changeStream = (key: StreamKey) => setStreamKey(key);
  const retryHealth = async () => {
    await health.reload();
    // Retry keeps the person oriented: focus returns to the stable section heading after the reread.
    queueMicrotask(() => healthHeading.current?.focus());
  };
  const checkDns = () => {
    const next = cleanSelectors(selectors);
    if (sameSelectors(next, appliedSelectors)) setDnsKey((value) => value + 1);
    else setAppliedSelectors(next);
  };

  return (
    <div className="space-y-6" aria-busy={refreshing || undefined}>
      <p role="status" aria-live="polite" className="sr-only">
        {refreshing ? 'Refreshing deliverability values.' : ''}
      </p>

      {health.data && !health.error && (
        <SelectedStreamTiles health={health.data} streamKey={streamKey} onRefresh={refresh} refreshing={refreshing} />
      )}
      <section aria-labelledby="health-heading" className="space-y-3">
        <h2 id="health-heading" ref={healthHeading} tabIndex={-1} className="text-[16px] leading-6 font-semibold outline-none">
          Delivery health{health.data ? ` · rolling ${health.data.windowDays} days` : ''}
        </h2>
        {health.loading ? (
          <LoadingSection label="Loading deliverability" lines={6} />
        ) : health.error ? (
          <SectionError title="Couldn’t load the health summary" error={health.error} onRetry={() => void retryHealth()}>
            Successful trend and DNS sections remain visible.
          </SectionError>
        ) : health.data ? (
          <StreamHealthSection health={health.data} />
        ) : null}
      </section>

      <TrendSection
        trend={trend.data}
        loading={trend.loading}
        error={trend.error}
        onRetry={() => trend.reload()}
        refreshing={refreshing}
        streamKey={streamKey}
        onStreamChange={changeStream}
        period={period}
        periodChoice={periodChoice}
        onPeriodChange={changePeriod}
      />

      <DnsSection
        data={domains.data}
        loading={domains.loading}
        error={domains.error}
        onRetry={() => domains.reload()}
        refreshing={domains.refreshing}
        admin={admin}
        selectors={selectors}
        onSelectorsChange={setSelectors}
        onCheck={checkDns}
      />
    </div>
  );
}
