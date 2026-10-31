import { Ban, Clock, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, EmptyState, formatDateTime, LoadingBlock, StatusPill, useConfirm, useToast } from '../../ui';
import { StatCard, StatGrid } from '../insights/Stats';
import type { Artifact } from './ArtifactDetailPage';

// Where a broadcast is: scheduled, sending, done or cancelled, with how many people it reached and
// skipped and what became of the e-mails. Sending is a run on the server, so the panel refreshes
// while it works.

const runTone = {
  not_scheduled: 'neutral',
  scheduled: 'info',
  running: 'info',
  done: 'good',
  cancelled: 'warn',
  failed: 'bad',
  stopped: 'warn',
} as const;
const runLabel = {
  not_scheduled: 'Not scheduled',
  scheduled: 'Scheduled',
  running: 'Sending',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
  stopped: 'Stopped',
} as const;

const stageLabel = {
  canary_sending: 'Sending canary',
  canary_waiting: 'Waiting on canary',
  checking: 'Checking canary',
  sending_rest: 'Sending the rest',
  stopped: 'Stopped at the canary check',
  done: 'Done',
} as const;
const stageTone = {
  canary_sending: 'info',
  canary_waiting: 'info',
  checking: 'info',
  sending_rest: 'info',
  stopped: 'warn',
  done: 'good',
} as const;

const MESSAGE_ORDER = ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'failed'];

const label = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(2).replace(/\.?0+$/, '')}%`);

/** Sending status and results of one broadcast, in its own tab on the artifact page. */
export function BroadcastStatus({ artifact }: { artifact: Artifact }) {
  const { can } = useWorkspace();
  const toast = useToast();
  const [dialog, confirm] = useConfirm();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [continueError, setContinueError] = useState<string | null>(null);
  const published = artifact.publishedVersion !== null;
  const status = useApi(() => api.call('broadcasts.status', { artifactId: artifact.id }), [artifact.id], { skip: !published });
  const archive = useApi(() => api.call('archive.issues', {}), [artifact.id], { skip: !published });
  const run = status.data?.run;
  const archived = archive.data?.issues.find((i) => i.artifactId === artifact.id);
  const cancellable = run?.status === 'scheduled' || run?.status === 'running';
  const sending = run?.status === 'running';

  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => void status.reload(), 10_000);
    return () => clearInterval(t);
  }, [sending, status.reload]);

  if (!published)
    return (
      <EmptyState title="It sends after it is approved" icon={<Clock size={16} />}>
        This broadcast is not live yet. Publish it, or have someone with approval rights approve it, then the sending status and results
        show here.
      </EmptyState>
    );

  if (status.loading) return <LoadingBlock lines={5} />;
  if (status.error || !status.data || !run)
    return (
      <Alert tone="bad" title="Couldn't load the sending status" onRetry={status.reload}>
        {status.error ?? 'The server returned no status.'}
      </Alert>
    );

  const messages = status.data.messages;
  const keys = [...MESSAGE_ORDER.filter((k) => k in messages), ...Object.keys(messages).filter((k) => !MESSAGE_ORDER.includes(k))];
  const test = status.data.test;
  const stage = status.data.stage;

  const cancel = async () => {
    const ok = await confirm({
      title: `Cancel sending “${artifact.name}”?`,
      body: 'Nobody else gets this broadcast. Messages already sent stay sent and cannot be recalled. This cannot be undone.',
      confirmLabel: 'Cancel sending',
      destructive: true,
      typeToConfirm: artifact.name,
    });
    if (!ok) return;
    setCancelError(null);
    try {
      const r = await api.call('broadcasts.cancel', { artifactId: artifact.id });
      toast.success(`Sending cancelled. ${r.queued.toLocaleString()} queued messages will not be sent.`);
      void status.reload();
    } catch (e) {
      setCancelError(errText(e));
    }
  };

  const sendRest = async () => {
    const ok = await confirm({
      title: `Send the rest of “${artifact.name}”?`,
      body: `${stage?.stopReason ?? 'The canary check stopped this send.'} Everyone who has not had it yet will get it now. This cannot be undone.`,
      confirmLabel: 'Send the rest',
      destructive: true,
    });
    if (!ok) return;
    setContinueError(null);
    try {
      await api.call('broadcasts.continue', { artifactId: artifact.id });
      toast.success('Sending the rest of the audience.');
      void status.reload();
    } catch (e) {
      setContinueError(errText(e));
    }
  };

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={runTone[run.status]}>{runLabel[run.status]}</StatusPill>
        {run.version !== null && <span className="text-[12px] text-muted">from v{run.version}</span>}
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={status.reload}>
          Refresh
        </Button>
        {archived && (
          <a
            href={archived.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
          >
            View in the archive <ExternalLink size={12} />
          </a>
        )}
        {cancellable && can('messages:send') && (
          <Button size="sm" variant="danger" icon={<Ban size={14} />} className="ml-auto" onClick={() => void cancel()}>
            Cancel sending
          </Button>
        )}
      </div>

      {cancelError && (
        <Alert tone="bad" title="Sending was not cancelled">
          {cancelError}
        </Alert>
      )}

      {run.error && (
        <Alert tone="bad" title="The last send failed">
          {run.error}
        </Alert>
      )}

      <StatGrid columns={4}>
        <StatCard
          label="Scheduled for"
          value={<span className="text-[13px] leading-5">{run.sendAt ? formatDateTime(run.sendAt, { zone: true }) : 'Not scheduled'}</span>}
          hint={run.sendAt ? 'In the workspace time zone' : 'It sends when it is published'}
        />
        <StatCard label="Recipients" value={run.recipients.toLocaleString()} hint="In the segment when it was scheduled" />
        <StatCard label="Queued" value={run.queued.toLocaleString()} hint="Waiting to be sent" />
        <StatCard
          label="Skipped"
          value={run.skipped.toLocaleString()}
          hint="Not eligible, no consent or gone"
          tone={run.skipped > 0 ? 'warn' : undefined}
        />
        {run.windowSkipped > 0 && (
          <StatCard
            label="Outside send window"
            value={run.windowSkipped.toLocaleString()}
            hint="Their next local window was later than the longest wait"
            tone="warn"
          />
        )}
        {keys.map((k) => (
          <StatCard key={k} label={label(k)} value={(messages[k] ?? 0).toLocaleString()} />
        ))}
      </StatGrid>

      {test && (
        <div className="rounded-md border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <span className="text-[13px] font-semibold text-fg">Subject test</span>
            <StatusPill tone={test.state === 'winner_sent' ? 'good' : 'info'}>
              {test.state === 'sampling' ? 'Sampling' : test.state === 'deciding' ? 'Waiting to decide' : 'Winner sent'}
            </StatusPill>
            {test.winner && <span className="text-[12px] text-muted">Variant {test.winner} wins</span>}
            <span className="ml-auto text-[12px] text-muted">
              {test.state === 'winner_sent'
                ? `Rest sent ${test.restAt ? formatDateTime(test.restAt, { zone: true }) : ''}`
                : test.restAt
                  ? `Rest goes ${formatDateTime(test.restAt, { zone: true })}`
                  : 'Decides after the first sample sends'}
            </span>
          </div>
          <div className="space-y-2 p-4">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-muted">
                  <th className="pb-1 font-medium">Variant</th>
                  <th className="pb-1 font-medium">Subject</th>
                  <th className="pb-1 text-right font-medium">Sent</th>
                  <th className="pb-1 text-right font-medium">Delivered</th>
                  <th className="pb-1 text-right font-medium">Opened</th>
                  <th className="pb-1 text-right font-medium">Clicked</th>
                  <th className="pb-1 text-right font-medium">{test.metric === 'click' ? 'Click rate' : 'Open rate'}</th>
                </tr>
              </thead>
              <tbody>
                {test.variants.map((v) => (
                  <tr key={v.variant} className={v.variant === test.winner ? 'font-semibold' : undefined}>
                    <td className="py-1 pr-3">{v.variant}</td>
                    <td className="max-w-[280px] truncate py-1 pr-3" title={v.subject}>
                      {v.subject}
                    </td>
                    <td className="py-1 text-right tabular-nums">{v.sent.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{v.delivered.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{v.opened.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{v.clicked.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{pct(test.metric === 'click' ? v.clickRate : v.openRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[12px] text-muted">
              {test.samplePercent}% sample; decided after {test.decideAfter}
              {test.reason ? ` — ${test.reason}.` : '.'} {test.metric === 'click' ? 'Clicks' : 'Opens'} pick the winner; ties and fewer than
              20 sends in a variant stay with variant A.
            </p>
          </div>
        </div>
      )}

      {stage && (
        <div className="rounded-md border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <span className="text-[13px] font-semibold text-fg">Staged send</span>
            <StatusPill tone={stageTone[stage.stage]}>{stageLabel[stage.stage]}</StatusPill>
            <span className="text-[12px] text-muted">
              {stage.canaryPercent}% canary, wait {stage.wait}
            </span>
            <span className="ml-auto text-[12px] text-muted">
              {stage.checkAt
                ? stage.stage === 'canary_waiting'
                  ? `Checks ${formatDateTime(stage.checkAt, { zone: true })}`
                  : stage.checkedAt
                    ? `Checked ${formatDateTime(stage.checkedAt, { zone: true })}`
                    : ''
                : ''}
            </span>
          </div>
          <div className="space-y-2 p-4">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-muted">
                  <th className="pb-1 font-medium">Canary</th>
                  <th className="pb-1 text-right font-medium">Sent</th>
                  <th className="pb-1 text-right font-medium">Bounced</th>
                  <th className="pb-1 text-right font-medium">Complained</th>
                  <th className="pb-1 text-right font-medium">Unsubscribed</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-1 pr-3">
                    {stage.canary.queued.toLocaleString()} queued of {stage.canary.recipients.toLocaleString()} reached
                    {stage.canary.skipped > 0 ? `, ${stage.canary.skipped.toLocaleString()} skipped` : ''}
                  </td>
                  <td className="py-1 text-right tabular-nums">{stage.sent.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">{stage.bounced.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">{stage.complained.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">{stage.unsubscribed.toLocaleString()}</td>
                </tr>
                <tr className="text-[12px] text-muted">
                  <td className="py-1 pr-3">Against the thresholds</td>
                  <td className="py-1 text-right" />
                  <td className="py-1 text-right tabular-nums">
                    {pct(stage.bounceRate)} / {pct(stage.thresholds.bounceRate)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {pct(stage.complaintRate)} / {pct(stage.thresholds.complaintRate)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {pct(stage.unsubscribeRate)} / {pct(stage.thresholds.unsubscribeRate)}
                  </td>
                </tr>
              </tbody>
            </table>
            {stage.checkSkipped && (
              <p className="text-[12px] text-muted">
                The canary had fewer than {stage.thresholds.minCanary.toLocaleString()} sends, so its rates were too small to judge and the
                rest went out without a check.
              </p>
            )}
            {stage.stopReason && (
              <p className="text-[12px] text-fg">
                {stage.stopReason}
                {stage.resumedAt ? ` The rest was sent after a person looked, ${formatDateTime(stage.resumedAt, { zone: true })}.` : ''}
              </p>
            )}
            {stage.stage === 'stopped' && run.status === 'stopped' && can('artifacts:publish') && (
              <Button size="sm" icon={<Play size={14} />} onClick={() => void sendRest()}>
                Send the rest
              </Button>
            )}
            {stage.stage === 'stopped' && run.status === 'stopped' && !can('artifacts:publish') && (
              <p className="text-[12px] text-muted">Sending the rest needs the artifacts:publish permission.</p>
            )}
          </div>
        </div>
      )}

      {continueError && (
        <Alert tone="bad" title="The rest was not sent">
          {continueError}
        </Alert>
      )}

      <dl className="grid grid-cols-[minmax(96px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
        {run.startedAt && (
          <>
            <dt className="text-muted">Started</dt>
            <dd>{formatDateTime(run.startedAt, { zone: true })}</dd>
          </>
        )}
        {run.finishedAt && (
          <>
            <dt className="text-muted">Finished</dt>
            <dd>{formatDateTime(run.finishedAt, { zone: true })}</dd>
          </>
        )}
      </dl>

      <p className="text-[12px] text-muted">
        {sending
          ? 'This panel refreshes every 10 seconds while it sends. Messages already sent are not recalled if you cancel.'
          : run.status === 'scheduled'
            ? 'Scheduled. You can cancel it until sending starts.'
            : run.status === 'not_scheduled'
              ? 'No run yet. It starts when the broadcast is published and its send time comes.'
              : run.status === 'stopped'
                ? 'The canary check stopped the rest. A person with the artifacts:publish permission can send the rest after looking at the rates.'
                : 'Counts come from the message events for this broadcast and grow as people open and click.'}
      </p>
      {cancellable && !can('messages:send') && (
        <p className="text-[12px] text-muted">Cancelling sending needs the messages:send permission.</p>
      )}
    </div>
  );
}
