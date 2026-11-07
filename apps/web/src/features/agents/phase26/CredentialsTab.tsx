import { type ReactNode, useState } from 'react';
import { api, errText, type Out } from '../../../app/api';
import { useApi } from '../../../app/useApi';
import { Alert, Button, Card, EmptyState, LoadingBlock, StatusPill, Table, Tag, Td, THead, Th, Tr } from '../../../ui';
import { Identifier } from '../../../ui/Identifier';
import { CREDENTIAL_KIND } from '../labels';
import { type AgentDetail, safeDateText, safeDateTimeText } from './model';

const RUN_STATUS: Record<string, { label: string; tone: 'good' | 'bad' | 'warn' }> = {
  ok: { label: 'Finished', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Skipped', tone: 'warn' },
};

// The Credentials tab (#509): the credentials already in agents.get, with their kind, since and a
// copy control. No secret value and no invented last-used time. Hosted runs are a separate lane
// read only when expanded, one agents.hostedRuns read for the first page and one per Load more.

export function CredentialsTab({ agent, canArtifacts }: { agent: AgentDetail; canArtifacts: boolean }) {
  if (!canArtifacts) {
    return (
      <Alert tone="info" title="Restricted by your role">
        Credentials need artifact access. No protected reads were made. Ask a workspace administrator for access.
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <Card
        title="Credentials"
        description="Each credential acts as this agent. Pausing or revoking the agent stops all of them at once. Secret values are never returned here."
      >
        {agent.credentials.length === 0 ? (
          <EmptyState compact title="No credentials">
            This agent has no API token, MCP client or hosted credential. It may have been revoked.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {agent.credentials.map((credential) => (
              <li key={`${credential.kind}:${credential.id}`} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <Tag>{CREDENTIAL_KIND[credential.kind] ?? credential.kind}</Tag>
                <Identifier value={credential.id} label={`${CREDENTIAL_KIND[credential.kind] ?? credential.kind} ID`} />
                <span className="ml-auto text-[12px] whitespace-nowrap text-muted">since {safeDateText(credential.since)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line px-4 py-3 text-[12px] leading-[18px] text-muted">
          Secret values are never shown. Last used is not recorded by this read, so it stays Unavailable.
        </p>
      </Card>

      <HostedLane agentId={agent.id} />
    </div>
  );
}

function HostedLane({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="Hosted runs" description="A separate source lane with its own cursor. It is read only when expanded.">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-10 cursor-pointer items-center px-4 py-2 text-[13px] font-medium text-accent">
          Show the hosted agent and its runs
        </summary>
        {open && <HostedBody agentId={agentId} />}
      </details>
    </Card>
  );
}

function HostedBody({ agentId }: { agentId: string }) {
  const [rows, setRows] = useState<{ runs: HostedRun[]; next: string | null; loaded: boolean }>({
    runs: [],
    next: null,
    loaded: false,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const first = useApi(() => api.call('agents.hostedRuns', { agentId, limit: 20 }), [agentId]);

  if (first.loading && !first.data) {
    return (
      <div role="status" aria-label="Loading hosted runs">
        <LoadingBlock lines={4} label="Loading hosted runs" />
      </div>
    );
  }
  if (first.error) {
    return (
      <div className="p-4">
        <Alert tone="bad" title="Couldn't load the hosted runs" onRetry={() => void first.reload()}>
          {first.error}
        </Alert>
      </div>
    );
  }

  const hosted = first.data?.hosted ?? null;
  if (!hosted) {
    return <p className="px-4 py-3 text-[13px] text-muted">The platform does not run this agent in a hosted session.</p>;
  }
  const runs = [...(first.data?.runs ?? []), ...rows.runs];
  const next = rows.loaded ? rows.next : (first.data?.next ?? null);

  const loadMore = async () => {
    if (next === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.call('agents.hostedRuns', { agentId, limit: 20, before: next });
      setRows((current) => ({ runs: [...current.runs, ...page.runs], next: page.next, loaded: true }));
    } catch (e) {
      setMoreError(errText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Schedule">
          {hosted.scheduleText}
          <span className="mt-0.5 block text-[11px] text-muted">
            {hosted.schedule} · {hosted.timeZone}
          </span>
        </Fact>
        <Fact label="State">
          <StatusPill tone={hosted.enabled ? 'good' : 'bad'}>{hosted.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
          <span className="mt-0.5 block text-[11px] text-muted">
            {hosted.nextRunAt ? `Next ${safeDateTimeText(hosted.nextRunAt)}` : 'No next run'}
          </span>
        </Fact>
        <Fact label="Budgets per run">
          {hosted.budgets.maxTokensPerRun.toLocaleString('en-US')} tokens
          <span className="mt-0.5 block text-[11px] text-muted">{hosted.budgets.maxToolCallsPerRun} tool calls</span>
        </Fact>
        <Fact label="Last run">{hosted.lastRunAt ? safeDateTimeText(hosted.lastRunAt) : 'Never'}</Fact>
      </div>

      {runs.length === 0 ? (
        <EmptyState compact title="No hosted runs yet">
          The first run appears here at its next scheduled time.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <Table label="Hosted agent runs">
            <THead>
              <tr>
                <Th>Started</Th>
                <Th>Status</Th>
                <Th>Summary</Th>
                <Th>Tool calls</Th>
                <Th>Tokens</Th>
              </tr>
            </THead>
            <tbody>
              {runs.map((run) => {
                const status = RUN_STATUS[run.status] ?? { label: run.status, tone: 'warn' as const };
                return (
                  <Tr key={run.id}>
                    <Td className="whitespace-nowrap">{safeDateTimeText(run.startedAt)}</Td>
                    <Td>
                      <StatusPill tone={status.tone}>{status.label}</StatusPill>
                    </Td>
                    <Td className="max-w-[420px]">
                      <span className="line-clamp-3 whitespace-pre-wrap text-[12px] text-fg-2">{run.summary || '—'}</span>
                      {run.error && <span className="mt-1 block text-[11px] break-words text-bad">{run.error}</span>}
                    </Td>
                    <Td>{run.toolCalls.toLocaleString('en-US')}</Td>
                    <Td>{run.tokens.toLocaleString('en-US')}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {next !== null && (
          <Button loading={loadingMore} onClick={() => void loadMore()}>
            Load more runs
          </Button>
        )}
        <span className="text-[12px] text-muted">
          {runs.length.toLocaleString('en-US')} {runs.length === 1 ? 'run' : 'runs'} shown
        </span>
      </div>
      {moreError && (
        <Alert tone="bad" title="Couldn't load more runs" onRetry={() => void loadMore()}>
          {moreError}
        </Alert>
      )}
    </div>
  );
}

type HostedRun = Out<'agents.hostedRuns'>['runs'][number];

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</p>
      <div className="mt-1 text-[13px] text-fg">{children}</div>
    </div>
  );
}
