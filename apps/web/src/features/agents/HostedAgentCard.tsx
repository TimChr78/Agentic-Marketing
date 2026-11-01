import { BookOpen, Brain, CalendarClock, Pencil, Play, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, errText } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { Link, navigate } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  formatDateTime,
  LoadingBlock,
  Mono,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
  useConfirm,
  useToast,
} from '../../ui';
import { HostedAgentDialog } from './HostedAgentDialog';
import type { HostedAgentRun } from './labels';

// The hosted side of an agent (#258): its schedule, budgets and enabled state, a Run now control
// and the run history with each run's summary, tool calls, tokens and error.

const RUN_STATUS: Record<HostedAgentRun['status'], { label: string; tone: 'good' | 'bad' | 'warn' }> = {
  ok: { label: 'Finished', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Skipped', tone: 'warn' },
};

export function HostedAgentCard({ agentId, onChanged }: { agentId: string; onChanged?: () => void }) {
  const { can } = useWorkspace();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null);
  const view = useApi(() => api.call('agents.hostedRuns', { agentId }), [agentId]);
  const memory = useApi(() => api.call('agents.memory.list', { agentId }), [agentId]);
  const skillArts = useApi(() => api.call('artifacts.list', { type: 'skill', limit: 200 }), []);
  const admin = can('workspace:admin');

  if (view.loading && !view.data)
    return (
      <Card title="Hosted runs">
        <LoadingBlock lines={4} label="Loading hosted runs" />
      </Card>
    );
  if (view.error && !view.data)
    return (
      <Card title="Hosted runs">
        <Alert tone="bad" title="Couldn't load the hosted agent" onRetry={() => void view.reload()}>
          {view.error}
        </Alert>
      </Card>
    );
  const hosted = view.data?.hosted;
  if (!hosted) return null;
  const runs = view.data?.runs ?? [];

  const runNow = async () => {
    setBusy(true);
    try {
      await api.call('agents.runHostedNow', { agentId });
      toast.success('Queued. The scheduler starts it within a minute; the run appears below.');
      await view.reload();
      onChanged?.();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${hosted.name}”?`,
      body: <>Its run history is deleted; the agent’s ledger entries stay. This cannot be undone.</>,
      confirmLabel: 'Delete hosted agent',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.call('agents.deleteHosted', { agentId });
      toast.success(`Deleted “${hosted.name}”.`);
      navigate('/settings/agents');
    } catch (e) {
      toast.error(errText(e));
      setBusy(false);
    }
  };

  const removeMemory = async (id: string) => {
    setMemoryBusy(id);
    try {
      await api.call('agents.memory.delete', { id });
      toast.success('Memory note deleted.');
      await memory.reload();
      onChanged?.();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setMemoryBusy(null);
    }
  };

  return (
    <>
      <Card
        title="Hosted runs"
        description={`The platform runs this agent itself, ${hosted.scheduleText.toLowerCase()} in ${hosted.timeZone}. Each run is a fresh session under the agent’s mandate.`}
        action={
          admin && (
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={<Play size={14} />} loading={busy} disabled={!hosted.enabled} onClick={() => void runNow()}>
                Run now
              </Button>
              <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            </div>
          )
        }
      >
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Schedule">
            <span className="flex items-center gap-1.5">
              <CalendarClock size={14} className="text-muted" />
              {hosted.scheduleText}
            </span>
            <Mono className="mt-0.5 block text-[11px] text-muted">{hosted.schedule}</Mono>
          </Fact>
          <Fact label="State">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill tone={hosted.enabled ? 'good' : 'bad'}>{hosted.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
              {!hosted.enabled && hosted.consecutiveFailures >= 3 && <span className="text-[12px] text-muted">after 3 failures</span>}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {hosted.enabled ? (hosted.nextRunAt ? `Next ${formatDateTime(hosted.nextRunAt)}` : 'No next run') : 'No runs until enabled'}
            </div>
          </Fact>
          <Fact label="Budgets per run">
            {hosted.budgets.maxTokensPerRun.toLocaleString('en-US')} tokens
            <br />
            {hosted.budgets.maxToolCallsPerRun} tool calls
          </Fact>
          <Fact label="Last run">
            {hosted.lastRunAt ? timeAgo(hosted.lastRunAt) : 'Never'}
            <div className="mt-0.5 text-[12px] text-muted">
              {hosted.consecutiveFailures
                ? `${hosted.consecutiveFailures} consecutive failure${hosted.consecutiveFailures === 1 ? '' : 's'}`
                : 'Healthy'}
            </div>
          </Fact>
        </div>
        <div className="border-t border-line px-4 py-3">
          <details>
            <summary className="cursor-pointer text-[12px] font-medium text-fg-2">Instructions and permissions</summary>
            <p className="mt-2 whitespace-pre-wrap text-[12px] text-fg-2">{hosted.instructions}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {hosted.scopes.map((s) => (
                <Tag key={s}>{s}</Tag>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-muted">
              {hosted.modelProviderId ? `Model provider ${hosted.modelProviderId}` : 'The workspace’s copilot provider'}
            </p>
          </details>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <BookOpen size={14} className="text-muted" />
          <span className="text-[12px] font-medium text-fg-2">Skills</span>
          {(hosted.skills ?? []).length === 0 ? (
            <span className="text-[12px] text-muted">None referenced. A skill’s published instructions are added to each run.</span>
          ) : (
            (hosted.skills ?? []).map((id) => {
              const skill = skillArts.data?.artifacts.find((a) => a.id === id);
              return (
                <Link key={id} to={artifactPath('skill', id)} className="text-[12px] text-accent hover:underline">
                  {skill?.name ?? id}
                  {skill && skill.publishedVersion === null ? ' (draft, not used yet)' : ''}
                </Link>
              );
            })
          )}
        </div>
        <div className="border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Brain size={14} className="text-muted" />
            <span className="text-[12px] font-medium text-fg-2">Memory</span>
            <span className="text-[12px] text-muted">
              {memory.data
                ? `${memory.data.count} of ${memory.data.limits.notes} notes · ${memory.data.characters.toLocaleString('en-US')} of ${memory.data.limits.characters.toLocaleString('en-US')} characters`
                : ''}
            </span>
          </div>
          {memory.error ? (
            <Alert tone="bad" title="Couldn't load the memory" onRetry={() => void memory.reload()}>
              {memory.error}
            </Alert>
          ) : (memory.data?.notes.length ?? 0) === 0 ? (
            <p className="mt-2 text-[12px] text-muted">
              No notes yet. The agent writes its own notes during a run, and people can add or delete them here.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {(memory.data?.notes ?? []).map((note) => (
                <li key={note.id} className="flex flex-wrap items-start gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-[12px] text-fg-2">{note.text}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {note.createdBy.type === 'run' ? 'Written by a run' : 'Written by a person'} · {timeAgo(note.createdAt)}
                    </p>
                  </div>
                  {admin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={13} />}
                      loading={memoryBusy === note.id}
                      onClick={() => void removeMemory(note.id)}
                    >
                      Delete
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <TableFrame
        loading={view.loading}
        error={view.error}
        onRetry={view.reload}
        columns={6}
        isEmpty={runs.length === 0}
        empty={
          <EmptyState title="No runs yet">
            The first run starts at {hosted.nextRunAt ? formatDateTime(hosted.nextRunAt) : 'the next scheduled time'}.
          </EmptyState>
        }
      >
        <Table label="Hosted agent runs">
          <THead>
            <tr>
              <Th>Started</Th>
              <Th>Status</Th>
              <Th>Summary</Th>
              <Th className="hidden md:table-cell">Tool calls</Th>
              <Th className="hidden md:table-cell">Tokens</Th>
              <Th className="hidden lg:table-cell">Error</Th>
            </tr>
          </THead>
          <tbody>
            {runs.map((run) => (
              <Tr key={run.id}>
                <Td className="whitespace-nowrap" title={formatDateTime(run.startedAt)}>
                  {timeAgo(run.startedAt)}
                </Td>
                <Td>
                  <StatusPill tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</StatusPill>
                </Td>
                <Td className="max-w-[420px]">
                  <div className="line-clamp-3 whitespace-pre-wrap text-[12px] text-fg-2">{run.summary || '—'}</div>
                </Td>
                <Td className="hidden md:table-cell">{run.toolCalls}</Td>
                <Td className="hidden md:table-cell">{run.tokens.toLocaleString('en-US')}</Td>
                <Td className="hidden max-w-[260px] text-[12px] break-words text-bad lg:table-cell">{run.error ?? '—'}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>

      {editing && (
        <HostedAgentDialog
          agent={hosted}
          onClose={() => setEditing(false)}
          onSaved={() => {
            void view.reload();
            onChanged?.();
          }}
        />
      )}
      {confirmDialog}
      {admin && (
        <div className="flex justify-end">
          <Button variant="danger" icon={<Trash2 size={14} />} loading={busy} onClick={() => void remove()}>
            Delete hosted agent
          </Button>
        </div>
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-1 text-[13px] text-fg">{children}</div>
    </div>
  );
}
