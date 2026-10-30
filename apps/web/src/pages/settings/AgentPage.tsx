import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useApi } from '../../app/useApi';
import { AgentControls } from '../../features/agents/AgentControls';
import { AgentStatusPill, DecisionBadge } from '../../features/agents/AgentStatus';
import {
  ACTION_CLASS_LABEL,
  type AgentAction,
  type AgentDecision,
  CREDENTIAL_KIND,
  DECISION,
  impactText,
} from '../../features/agents/labels';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  formatDate,
  formatDateTime,
  LoadingBlock,
  Mono,
  PageHeader,
  Select,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

const LIMIT = 50;

/** One agent (#213): its status and stop controls, credentials, and the action ledger. */
export default function AgentPage({ params }: { params: Record<string, string> }) {
  const id = params.id ?? '';
  const agent = useApi(() => api.call('agents.get', { id }), [id]);
  useCrumbs([{ label: 'Agents', to: '/settings/agents' }, { label: agent.data?.name ?? 'Agent' }]);

  if (agent.loading && !agent.data) return <LoadingBlock lines={6} label="Loading agent" />;
  if (agent.error && !agent.data)
    return (
      <Alert tone="bad" title="Couldn't load this agent" onRetry={() => void agent.reload()}>
        {agent.error}
      </Alert>
    );
  if (!agent.data) return <EmptyState title="Agent not found">The agent may have been removed, or the address is mistyped.</EmptyState>;

  const a = agent.data;
  return (
    <div className={pageWidth('default', 'space-y-5')}>
      <PageHeader
        title={a.name}
        meta={
          <>
            <AgentStatusPill status={a.status} />
            <span>Sponsored by {a.sponsor.name}</span>
            <Mono>{a.id}</Mono>
          </>
        }
        description={a.description || 'An agent acts for this workspace through its API token or MCP client.'}
        actions={<AgentControls agent={a} onChanged={() => void agent.reload()} />}
      />

      {a.status === 'paused' && (
        <Alert tone="warn" title="Paused">
          {a.statusReason ? `“${a.statusReason}”` : 'No reason given.'} Its credentials are refused until it is resumed.
        </Alert>
      )}
      {a.status === 'revoked' && (
        <Alert tone="bad" title="Revoked">
          {a.statusReason ? `“${a.statusReason}”` : 'No reason given.'} This cannot be undone; its history stays readable.
        </Alert>
      )}

      <Card title="Credentials" description="Each one acts as this agent; pausing or revoking the agent stops all of them at once.">
        {a.credentials.length === 0 ? (
          <p className="p-4 text-[13px] text-muted">No credentials. The agent may have had its token revoked.</p>
        ) : (
          <ul className="divide-y divide-line">
            {a.credentials.map((c) => (
              <li key={`${c.kind}:${c.id}`} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <Tag>{CREDENTIAL_KIND[c.kind] ?? c.kind}</Tag>
                <Mono className="min-w-0 break-all">{c.id}</Mono>
                <span className="ml-auto text-[12px] whitespace-nowrap text-muted">since {formatDate(c.since)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Activity agentId={a.id} />
    </div>
  );
}

/** The action ledger for this agent: every write, its decision, the reasons, impact and result. */
function Activity({ agentId }: { agentId: string }) {
  const [decision, setDecision] = useState<AgentDecision | ''>('');
  const [more, setMore] = useState<{ rows: AgentAction[]; next: number | null; loaded: boolean }>({
    rows: [],
    next: null,
    loaded: false,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const list = useApi(
    () =>
      api.call('agents.activity', {
        agentId,
        limit: LIMIT,
        ...(decision ? { decision } : {}),
      }),
    [agentId, decision],
  );

  // A new filter is a new ledger; pages loaded for the old one no longer belong to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset paging whenever the filter changes, which the body does not read
  useEffect(() => {
    setMore({ rows: [], next: null, loaded: false });
    setMoreError(null);
  }, [decision]);

  const actions = [...(list.data?.actions ?? []), ...more.rows];
  const next = more.loaded ? more.next : (list.data?.next ?? null);
  const filtered = decision !== '';

  const loadMore = async () => {
    if (next === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await api.call('agents.activity', {
        agentId,
        limit: LIMIT,
        before: next,
        ...(decision ? { decision } : {}),
      });
      setMore((m) => ({ rows: [...m.rows, ...r.actions], next: r.next, loaded: true }));
    } catch (e) {
      setMoreError(errText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Card
      title="Activity"
      description="Every agent write, newest first, with the policy’s decision and why. It runs on the server; paging keeps the same filter."
      action={
        <Select
          compact
          className="w-auto"
          aria-label="Decision"
          value={decision}
          onChange={(e) => setDecision(e.target.value as AgentDecision | '')}
        >
          <option value="">All decisions</option>
          {(Object.keys(DECISION) as AgentDecision[]).map((d) => (
            <option key={d} value={d}>
              {DECISION[d].label}
            </option>
          ))}
        </Select>
      }
    >
      <TableFrame
        className="rounded-none border-0"
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        columns={7}
        isEmpty={actions.length === 0}
        empty={
          <EmptyState compact title={filtered ? 'Nothing matches' : 'No activity yet'}>
            {filtered
              ? 'Clear the decision filter to see the whole ledger.'
              : 'When this agent changes something, the decision, its reasons and the impact show here.'}
          </EmptyState>
        }
      >
        <Table label="Agent activity">
          <THead>
            <tr>
              <Th>When</Th>
              <Th>Command</Th>
              <Th className="hidden md:table-cell">Action class</Th>
              <Th>Decision</Th>
              <Th>Why</Th>
              <Th className="hidden lg:table-cell">Impact</Th>
              <Th>Result</Th>
            </tr>
          </THead>
          <tbody>
            {actions.map((action) => (
              <Tr key={action.id}>
                <Td className="whitespace-nowrap" title={formatDateTime(action.at)}>
                  {timeAgo(action.at)}
                </Td>
                <Td>
                  <Mono>{action.command}</Mono>
                  <div className="mt-0.5 text-[11px] text-muted md:hidden">
                    {ACTION_CLASS_LABEL[action.actionClass] ?? action.actionClass}
                  </div>
                </Td>
                <Td className="hidden md:table-cell">{ACTION_CLASS_LABEL[action.actionClass] ?? action.actionClass}</Td>
                <Td>
                  <DecisionBadge decision={action.decision} />
                </Td>
                <Td className="min-w-[220px] max-w-[380px]">
                  {action.reasons.length === 0 ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-fg-2">
                      {action.reasons.map((reason, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: policy reasons are an ordered list of sentences that may repeat
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </Td>
                <Td className="hidden max-w-[260px] text-[12px] lg:table-cell">{impactText(action) ?? '—'}</Td>
                <Td>
                  {action.ok ? (
                    <StatusPill tone="good">Succeeded</StatusPill>
                  ) : (
                    <>
                      <StatusPill tone="bad">Failed</StatusPill>
                      {action.error && <div className="mt-1 max-w-[240px] text-[11px] break-words text-bad">{action.error}</div>}
                    </>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {(next !== null || moreError) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          {moreError && (
            <Alert tone="bad" className="w-full">
              {moreError}
            </Alert>
          )}
          {next !== null && (
            <Button loading={loadingMore} onClick={() => void loadMore()}>
              Load more
            </Button>
          )}
          <span className="text-[12px] text-muted">
            {actions.length} {actions.length === 1 ? 'entry' : 'entries'} shown
          </span>
        </div>
      )}
    </Card>
  );
}
