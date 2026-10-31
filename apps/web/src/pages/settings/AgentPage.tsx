import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useApi } from '../../app/useApi';
import { AgentControls } from '../../features/agents/AgentControls';
import { AgentStatusPill, DecisionBadge } from '../../features/agents/AgentStatus';
import { GuardianCard } from '../../features/agents/GuardianCard';
import { HostedAgentCard } from '../../features/agents/HostedAgentCard';
import {
  ACTION_CLASS_LABEL,
  type AgentAction,
  type AgentDecision,
  CREDENTIAL_KIND,
  DECISION,
  impactText,
} from '../../features/agents/labels';
import { MandateCard } from '../../features/agents/MandateCard';
import { ReportCard } from '../../features/agents/ReportCard';
import { ShadowCard } from '../../features/agents/ShadowCard';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  formatDate,
  formatDateTime,
  LoadingBlock,
  Modal,
  Mono,
  PageHeader,
  Select,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
  timeAgo,
  useToast,
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

      <GuardianCard agent={a} onChanged={() => void agent.reload()} />

      <MandateCard agent={a} />

      <ShadowCard agentId={a.id} />

      <ReportCard agentId={a.id} />

      <HostedAgentCard agentId={a.id} onChanged={() => void agent.reload()} />

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
  const [undoing, setUndoing] = useState<AgentAction | null>(null);

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
        columns={8}
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
              <Th>Undo</Th>
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
                  {action.mandateVersion !== null && action.mandateId && (
                    <div className="mt-0.5 text-[11px] text-muted">
                      <Link to={artifactPath('agent_mandate', action.mandateId)} className="hover:underline">
                        Mandate v{action.mandateVersion}
                      </Link>
                    </div>
                  )}
                  {action.intent && (
                    <div className="mt-0.5 max-w-[320px] line-clamp-2 text-[12px] text-muted" title={action.intent}>
                      {action.intent}
                    </div>
                  )}
                  <div className="mt-0.5 text-[11px] text-muted md:hidden">
                    {ACTION_CLASS_LABEL[action.actionClass] ?? action.actionClass}
                  </div>
                </Td>
                <Td className="hidden md:table-cell">{ACTION_CLASS_LABEL[action.actionClass] ?? action.actionClass}</Td>
                <Td>
                  <DecisionBadge decision={action.decision} />
                  {action.shadow && (
                    <div className="mt-1 text-[11px] whitespace-nowrap text-muted" title={action.shadow.reasons.join(' ')}>
                      Shadow: {DECISION[action.shadow.decision].label.toLowerCase()}
                    </div>
                  )}
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
                <Td>
                  {action.undoneAt ? (
                    <div className="max-w-[240px] text-[12px]">
                      <StatusPill tone="warn">Undone</StatusPill>
                      {action.undoResult && <div className="mt-1 break-words text-muted">{action.undoResult}</div>}
                    </div>
                  ) : action.undoable ? (
                    <Button onClick={() => setUndoing(action)}>Undo</Button>
                  ) : action.undoBlockedBy ? (
                    <span className="block max-w-[200px] text-[12px] text-muted">{action.undoBlockedBy}</span>
                  ) : (
                    <span className="text-[12px] text-muted">—</span>
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
      {undoing && (
        <UndoDialog
          action={undoing}
          onClose={() => setUndoing(null)}
          onUndone={() => {
            setUndoing(null);
            setMore({ rows: [], next: null, loaded: false });
            void list.reload();
          }}
        />
      )}
    </Card>
  );
}

/** Undo one agent action (#255): a short confirmation with a note, kept in the ledger. */
function UndoDialog({ action, onClose, onUndone }: { action: AgentAction; onClose: () => void; onUndone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      const out = await api.call('agents.undo', { actionId: action.id, ...(trimmed ? { note: trimmed } : {}) });
      toast.success(out.result);
      onUndone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Undo ${action.command}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Undo
          </Button>
        </>
      }
    >
      <p>
        This reverses what the agent did: the version that was live before goes back live, and a broadcast that has not gone out is
        cancelled. A message that was already sent cannot be recalled.
      </p>
      {action.intent && <p className="mt-2 text-muted">The agent said: “{action.intent}”</p>}
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Note (optional)" hint="Why you are undoing it; kept with the ledger entry.">
          <Textarea
            rows={3}
            maxLength={1000}
            value={note}
            data-autofocus
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Wrong segment"
          />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
