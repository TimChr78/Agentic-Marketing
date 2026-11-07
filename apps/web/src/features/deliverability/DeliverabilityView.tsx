import { type ReactNode, useState } from 'react';
import { api } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
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

  const health = useApi(() => api.call('deliverability.health', {}), [refreshKey], { skip: !canRead });
  const stream = streamOf(streamKey);
  const trend = useApi(
    () =>
      api.call('deliverability.trend', {
        from: period.from,
        to: period.nextMidnight,
        channel: stream.channel,
        stream: stream.stream,
      }),
    [period.from, period.nextMidnight, streamKey, refreshKey],
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

      {health.loading ? (
        <LoadingSection label="Loading deliverability" lines={6} />
      ) : health.error ? (
        <SectionError title="Couldn’t load the health summary" error={health.error} onRetry={() => void health.reload()}>
          Successful trend and DNS sections remain visible.
        </SectionError>
      ) : health.data ? (
        <>
          <SelectedStreamTiles health={health.data} streamKey={streamKey} onRefresh={refresh} refreshing={refreshing} />
          <StreamHealthSection health={health.data} />
        </>
      ) : null}

      <TrendSection
        trend={trend.data}
        loading={trend.loading}
        error={trend.error}
        onRetry={() => void trend.reload()}
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
        onRetry={() => void domains.reload()}
        refreshing={domains.refreshing}
        admin={admin}
        selectors={selectors}
        onSelectorsChange={setSelectors}
        onCheck={checkDns}
      />
    </div>
  );
}
