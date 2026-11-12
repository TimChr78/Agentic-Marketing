import { useMemo, useState } from 'react';
import { api, type Out } from '../../../app/api';
import { TextLink } from '../../../app/links';
import { useWorkspace } from '../../../app/session';
import { useApi } from '../../../app/useApi';
import { Alert, BarChart, Button, DetailSkeleton, Field, ListSkeleton, Select, Table, Tag, Td, Th, Tr } from '../../../ui';
import { Identifier } from '../../../ui/Identifier';
import { formatDateTime } from '../../../ui/time';
import { type LocalDayPeriod, periodDateLabel, type ReportPeriodChoice, reportPeriod } from '../../broadcasts/period';
import { HoldoutCard } from '../../insights/HoldoutCard';
import { StatCard, StatGrid } from '../../insights/Stats';
import type { JNode, JourneyContent } from '../model';
import {
  conversionText,
  countText,
  type FunnelGateResult,
  freshnessOf,
  funnelGate,
  nowTotal,
  readStats,
  type StatsView,
  type StepRow,
  stepRows,
} from './model';

// The Phase 26 journey report (#507). It builds on the Phase 24 Report tab: current snapshot,
// selected-period reach and all-time reach stay separate, a funnel appears only where a single
// linear topology makes one honest, and every unavailable value is the word Unavailable rather
// than an invented zero.

type Artifact = Out<'artifacts.get'>;
type Funnel = Out<'analytics.journeyFunnel'>;

// Tables keep their columns on wider screens and become labelled row stacks on phones
// (DESIGN.md → tables on phones), without duplicating the values in a second DOM tree.
const rowCellClass =
  'max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:border-0 max-sm:px-0 max-sm:py-1 max-sm:before:text-muted max-sm:before:content-[attr(data-label)]';

export function JourneyReport({
  journeyId,
  active = true,
  artifact: hostArtifact,
}: {
  journeyId: string;
  active?: boolean;
  /** The artifact the host page already loaded; embedded use then needs no duplicate host read. */
  artifact?: Artifact;
}) {
  const { can } = useWorkspace();
  if (!can('artifacts:read'))
    return (
      <Alert tone="info" title="Restricted by your role">
        No protected reads were made. Ask a workspace administrator for access.
      </Alert>
    );
  if (!active) return null;
  return <AuthorizedReport journeyId={journeyId} hostArtifact={hostArtifact} />;
}

const notFound = (message: string) => /does not exist|not found|not_found/i.test(message);

function AuthorizedReport({ journeyId, hostArtifact }: { journeyId: string; hostArtifact?: Artifact }) {
  const host = useApi(() => api.call('artifacts.get', { artifactId: journeyId }), [journeyId], { skip: !!hostArtifact });
  const artifact = hostArtifact ?? host.data;
  const hostLoading = !hostArtifact && host.loading;
  const hostError = hostArtifact ? null : host.error;
  const pinnedVersion = artifact?.publishedVersion ?? null;
  const needsPinned = !!artifact && pinnedVersion !== null && artifact.version.number !== pinnedVersion;
  const pinned = useApi(
    () => api.call('artifacts.get', { artifactId: journeyId, version: pinnedVersion ?? 0 }),
    [journeyId, pinnedVersion, artifact?.version.number],
    { skip: !needsPinned },
  );

  if (hostLoading && !artifact) return <LoadingSection label="Loading the journey report" />;
  if (hostError)
    return notFound(hostError) ? (
      <Alert tone="info" title="This item is not available at this address.">
        <TextLink to="/marketing/journeys">Return to the list</TextLink>
      </Alert>
    ) : (
      <Alert tone="bad" title="Could not load the journey" onRetry={host.reload}>
        {hostError} No old values are shown as current.
      </Alert>
    );
  if (!artifact) return null;

  if (needsPinned) {
    if (pinned.error)
      return (
        <Alert tone="bad" title="Could not load the published version" onRetry={pinned.reload}>
          {pinned.error}
        </Alert>
      );
    if (!pinned.data) return <LoadingSection label="Loading the published topology" />;
  }

  const topology = needsPinned ? pinned.data! : artifact;
  return <ReportBody journeyId={journeyId} artifact={artifact} topology={topology} />;
}

function LoadingSection({ label }: { label: string }) {
  return (
    <section aria-busy="true" aria-label={label}>
      <DetailSkeleton label={label} />
    </section>
  );
}

function ReportBody({ journeyId, artifact, topology }: { journeyId: string; artifact: Artifact; topology: Artifact }) {
  const [choice, setChoice] = useState<ReportPeriodChoice>(7);
  const [anchor, setAnchor] = useState(() => new Date());
  const [refresh, setRefresh] = useState(0);
  const [holdoutOpen, setHoldoutOpen] = useState(false);
  const period = useMemo(() => reportPeriod(choice, anchor), [choice, anchor]);

  // One all-time stats read for the whole report. A period change only re-reads the funnel.
  const stats = useApi(() => api.call('journeys.stats', { artifactId: journeyId }), [journeyId, refresh]);
  const statsView = readStats(stats.data);
  const statsBusy = stats.loading || stats.refreshing;

  const published = artifact.publishedVersion !== null;
  const content = topology.version.content as JourneyContent;

  const refreshAll = () => {
    setAnchor(new Date());
    setRefresh((value) => value + 1);
  };
  const choosePeriod = (value: number) => {
    setAnchor(new Date());
    setChoice(value === 30 ? 30 : 7);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-[12px] leading-[18px] text-muted">
          {artifact.publishedVersion !== null
            ? `Published v${artifact.publishedVersion} · counts across all versions`
            : 'Draft · no published topology'}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Period" className="w-[220px]">
            <Select value={choice} onChange={(event) => choosePeriod(Number(event.target.value))}>
              <option value={7}>Last 7 complete days</option>
              <option value={30}>Last 30 complete days</option>
            </Select>
          </Field>
          <Button variant="secondary" onClick={refreshAll}>
            Refresh
          </Button>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        Showing the last {choice} complete days, {periodDateLabel(period)}, {period.zone}.
      </p>

      <CurrentParticipants view={statsView} busy={statsBusy} error={stats.error} onRetry={() => void stats.reload()} />

      {published ? (
        <PeriodReads
          key={`${period.from}:${period.to}:${refresh}`}
          journeyId={journeyId}
          artifact={artifact}
          nodes={(content.nodes ?? []).filter(Boolean)}
          statsView={statsView}
          period={period}
        />
      ) : (
        <NoPublication view={statsView} busy={statsBusy} />
      )}

      {published && content.controlGroup && (
        <HoldoutSection
          key={`${period.from}:${period.to}`}
          journeyId={journeyId}
          from={period.from}
          to={period.to}
          open={holdoutOpen}
          onToggle={() => setHoldoutOpen((open) => !open)}
        />
      )}
    </div>
  );
}

function CurrentParticipants({
  view,
  busy,
  error,
  onRetry,
}: {
  view: StatsView;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="space-y-3" aria-busy={busy || undefined} aria-label="Current participants">
      <h2 className="text-[16px] leading-6 font-semibold">Current participants</h2>
      {busy ? (
        <ListSkeleton label="Loading current participants" rows={3} columns={3} />
      ) : error ? (
        <Alert tone="bad" title="Participant counts unavailable" onRetry={onRetry}>
          {error}
        </Alert>
      ) : !view.available || !view.now ? (
        <Alert tone="info" title="Values unavailable">
          Values unavailable. This read does not provide the required metric or freshness. No estimate is substituted.
        </Alert>
      ) : (
        <>
          <p className="text-[12px] leading-[18px] text-muted">Current participant state</p>
          <StatGrid className="max-sm:grid-cols-1">
            <StatCard label="Ready" value={view.now.ready.toLocaleString()} hint="Waiting to start" />
            <StatCard label="Waiting" value={view.now.waiting.toLocaleString()} hint="At a step now" />
            <StatCard label="Completed" value={view.now.completed.toLocaleString()} />
            <StatCard label="Exited" value={view.now.exited.toLocaleString()} />
            <StatCard label="Failed" value={view.now.failed.toLocaleString()} tone={view.now.failed > 0 ? 'bad' : undefined} />
            <StatCard label="Converted" value={view.now.converted.toLocaleString()} tone={view.now.converted > 0 ? 'good' : undefined} />
          </StatGrid>
          <p className="text-[12px] leading-[18px] text-muted">
            Duplicate entries skipped (all time): {countText(view.duplicatesSkipped)} · Missing entry key skipped (all time):{' '}
            {countText(view.missingKeySkipped)}
          </p>
          <p className="text-[12px] leading-[18px] text-muted">Latest event in period: Unavailable</p>
        </>
      )}
    </section>
  );
}

function PeriodReads({
  journeyId,
  artifact,
  nodes,
  statsView,
  period,
}: {
  journeyId: string;
  artifact: Artifact;
  nodes: JNode[];
  statsView: StatsView;
  period: LocalDayPeriod;
}) {
  const funnel = useApi(
    () => api.call('analytics.journeyFunnel', { journeyId, from: period.from, to: period.to }),
    [journeyId, period.from, period.to],
  );
  const result = funnel.data;
  const steps = result?.steps ?? [];
  const meta = result?.meta;
  const suppressed = meta?.suppressed ?? 0;
  const k = meta?.k ?? 5;

  const gate = useMemo<FunnelGateResult | null>(() => {
    if (!result) return null;
    return funnelGate({
      basis: result.basis,
      latestVersion: artifact.latestVersion,
      publishedVersion: artifact.publishedVersion,
      nodes,
      steps: steps.map((step) => ({ step: step.step, reached: step.reached })),
      entered: result.entered,
      suppressed,
      k,
    });
  }, [artifact.latestVersion, artifact.publishedVersion, nodes, result, steps, suppressed, k]);

  const rows = stepRows({
    nodes,
    steps,
    reached: statsView.reached,
    waitingAt: statsView.waitingAt,
  });

  const busy = funnel.loading || funnel.refreshing;
  const empty =
    !busy && !funnel.error && !!result && result.entered === 0 && steps.length === 0 && statsView.available && nowTotal(statsView) === 0;

  return (
    <div className="space-y-5">
      <p className="text-[12px] leading-[18px] text-muted">
        {periodDateLabel(period)} · {period.zone} · Latest event in period (step events):{' '}
        {freshnessOf(meta?.freshness) ? formatDateTime(freshnessOf(meta?.freshness)) : 'Unavailable'}
      </p>

      {busy ? (
        <LoadingSection label="Loading period reach" />
      ) : funnel.error ? (
        <Alert tone="bad" title="Period reach unavailable" onRetry={() => void funnel.reload()}>
          {funnel.error}
        </Alert>
      ) : empty ? (
        <Alert tone="info" title="No recorded activity in this period. Choose another period; missing data is not a healthy result." />
      ) : (
        result && (
          <>
            <PeriodTotals result={result} suppressed={suppressed} k={k} />
            <StepReach gate={gate} rows={rows} meta={meta} suppressed={suppressed} />
          </>
        )
      )}
    </div>
  );
}

function PeriodTotals({ result, suppressed, k }: { result: Funnel; suppressed: number; k: number }) {
  const notes = result.meta?.notes ?? [];
  return (
    <div className="space-y-3">
      <StatGrid columns={4} className="max-sm:grid-cols-1">
        <StatCard label="Entered in period" value={countText(result.entered)} hint="Distinct participants" />
        <StatCard
          label="Reached goal in period"
          value={countText(result.goalReached)}
          hint={conversionText(result.goalReached, result.entered)}
        />
        <StatCard label="Completed in period" value={countText(result.completed)} />
        <StatCard label="Exited in period" value={countText(result.exited)} />
      </StatGrid>
      {suppressed > 0 && (
        <Alert tone="warn" title={`Values unavailable — fewer than ${k} people.`}>
          The server suppressed this breakdown; no identities or inferred values are shown.
          {notes.length > 0 && <span> {notes.join(' ')}</span>}
        </Alert>
      )}
      {result.entered === 0 && suppressed === 0 && (
        <Alert tone="info" title="Zero recorded events does not prove no engagement.">
          Latest event in period (step events):{' '}
          {freshnessOf(result.meta?.freshness) ? formatDateTime(freshnessOf(result.meta?.freshness)) : 'Unavailable'}.
        </Alert>
      )}
    </div>
  );
}

function StepReach({
  gate,
  rows,
  meta,
  suppressed,
}: {
  gate: FunnelGateResult | null;
  rows: ReturnType<typeof stepRows>;
  meta: Funnel['meta'] | undefined;
  suppressed: number;
}) {
  const bars = rows.known.map((row) => ({ label: row.label ?? row.id, value: row.period }));
  const freshness = freshnessOf(meta?.freshness) ? formatDateTime(freshnessOf(meta?.freshness)) : 'Unavailable';
  return (
    <section className="space-y-4">
      <h2 className="text-[16px] leading-6 font-semibold">Step reach</h2>

      {gate?.pass ? (
        <BarChart
          title="Sequential event reach"
          data={gate.stages.map((stage) => ({ label: stage.label, value: stage.reached }))}
          ordered
          height={Math.max(160, gate.stages.length * 36)}
          unit="people"
          summary={gate.notice}
          note="Event reach by step, not an entry cohort; a person may reach a later step without the previous one."
        />
      ) : gate ? (
        <>
          <Alert tone="info" title={gate.notice} />
          <BarChart
            title="Participants reaching steps · selected period"
            data={bars}
            ordered
            height={Math.max(160, bars.length * 36)}
            unit="people"
            note="Step reach is not a cohort funnel."
          />
        </>
      ) : null}

      {gate?.pass && <StageTable gate={gate} />}

      <StepTable rows={rows.known} />

      {rows.history.length > 0 && <HistoryTable rows={rows.history} />}

      <p className="text-[12px] leading-[18px] text-muted">
        Period reach: distinct participants by event date. Latest event in period (step events): {freshness}. Snapshot freshness
        unavailable.
        {suppressed > 0 ? ' Server-suppressed step counts remain unavailable and are never inferred.' : ''}
      </p>
    </section>
  );
}

function StageTable({ gate }: { gate: Extract<FunnelGateResult, { pass: true }> }) {
  return (
    <div className="overflow-x-auto">
      <Table label="Sequential event reach" className="max-sm:block">
        <thead className="bg-surface-2 text-[13px] leading-5 text-muted max-sm:hidden">
          <tr>
            <Th>Stage</Th>
            <Th align="right">Participants</Th>
            <Th align="right">Difference / previous</Th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {gate.stages.map((stage) => {
            const previous = stage.difference === null ? null : stage.reached + stage.difference;
            const difference =
              stage.difference === null || stage.differenceRate === null || previous === null
                ? '—'
                : `${stage.difference.toLocaleString()} / ${previous.toLocaleString()} = ${(stage.differenceRate * 100).toFixed(1)}%`;
            return (
              <Tr key={stage.step ?? 'entered'} className="max-sm:block max-sm:border-b max-sm:border-line max-sm:py-2">
                <Td className={rowCellClass} data-label="Stage">
                  {stage.label}
                </Td>
                <Td className={rowCellClass} data-label="Participants" align="right">
                  {stage.reached.toLocaleString()}
                </Td>
                <Td className={rowCellClass} data-label="Difference / previous" align="right">
                  {difference}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

function StepTable({ rows }: { rows: StepRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table label="Journey steps" className="max-sm:block">
        <thead className="bg-surface-2 text-[13px] leading-5 text-muted max-sm:hidden">
          <tr>
            <Th>Step</Th>
            <Th align="right">Period reach</Th>
            <Th align="right">All-time reach</Th>
            <Th align="right">Waiting now</Th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {rows.map((row) => (
            <Tr key={row.id} className="max-sm:block max-sm:border-b max-sm:border-line max-sm:py-2">
              <Td className={rowCellClass} data-label="Step">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-fg">{row.label}</span>
                  {row.kind && <Tag>{row.kind}</Tag>}
                  <Identifier value={row.id} label="Step ID" />
                </span>
              </Td>
              <Td className={rowCellClass} data-label="Period reach" align="right">
                {countText(row.period)}
              </Td>
              <Td className={rowCellClass} data-label="All-time reach" align="right">
                {countText(row.allTime)}
              </Td>
              <Td className={rowCellClass} data-label="Waiting now" align="right">
                {countText(row.waiting)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function HistoryTable({ rows }: { rows: StepRow[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[14px] leading-5 font-semibold">Unmapped historical steps</h3>
      <div className="overflow-x-auto">
        <Table label="Unmapped historical steps" className="max-sm:block">
          <thead className="bg-surface-2 text-[13px] leading-5 text-muted max-sm:hidden">
            <tr>
              <Th>Step</Th>
              <Th align="right">All-time reach</Th>
              <Th align="right">Waiting now</Th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {rows.map((row) => (
              <Tr key={row.id} className="max-sm:block max-sm:border-b max-sm:border-line max-sm:py-2">
                <Td className={rowCellClass} data-label="Step">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span>Historical step · name unavailable</span>
                    <Identifier value={row.id} label="Step ID" />
                  </span>
                </Td>
                <Td className={rowCellClass} data-label="All-time reach" align="right">
                  {countText(row.allTime)}
                </Td>
                <Td className={rowCellClass} data-label="Waiting now" align="right">
                  {countText(row.waiting)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

function HoldoutSection({
  journeyId,
  from,
  to,
  open,
  onToggle,
}: {
  journeyId: string;
  from: string;
  to: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="space-y-3">
      <Button variant="secondary" aria-expanded={open} onClick={onToggle}>
        Holdout
      </Button>
      {open && <HoldoutRead journeyId={journeyId} from={from} to={to} />}
    </section>
  );
}

/** Loaded on expand only; a report Refresh does not re-read it, while a period change does. */
function HoldoutRead({ journeyId, from, to }: { journeyId: string; from: string; to: string }) {
  const holdout = useApi(() => api.call('journeys.holdoutResult', { journeyId, from, to }), [journeyId, from, to]);
  return <HoldoutCard result={holdout.data} loading={holdout.loading} error={holdout.error ?? undefined} />;
}

function NoPublication({ view, busy }: { view: StatsView; busy: boolean }) {
  const rows = stepRows({ nodes: [], steps: [], reached: view.reached, waitingAt: view.waitingAt });
  return (
    <section className="space-y-3">
      <Alert tone="info" title="No published topology. Draft preview has no live count overlay." />
      {busy ? (
        <ListSkeleton label="Loading historical counts" rows={3} columns={3} />
      ) : !view.available ? (
        <Alert tone="info" title="Values unavailable">
          Values unavailable. This read does not provide the required metric or freshness. No estimate is substituted.
        </Alert>
      ) : rows.history.length > 0 ? (
        <HistoryTable rows={rows.history} />
      ) : null}
    </section>
  );
}
