import { useEffect, useRef, useState } from 'react';
import { api, errText } from '../../../app/api';
import { artifactPath } from '../../../app/artifactRoutes';
import { Link } from '../../../app/router';
import { useApi } from '../../../app/useApi';
import { Alert, Button, Card, EmptyState, Skeleton, StatusPill, Tag } from '../../../ui';
import { Identifier } from '../../../ui/Identifier';
import { DecisionBadge } from '../AgentStatus';
import { GuardianCard } from '../GuardianCard';
import { actionClassLabel, DECISION, impactText } from '../labels';
import { ShadowCard } from '../ShadowCard';
import { type AgentActionRow, type AgentActivity, type AgentDetail, intText, safeDateText, safeDateTimeText } from './model';
import { useFetchedAt } from './useFetchedAt';

const LIMIT = 50;

// The Activity tab (#509): the action ledger as a timeline with a cursor, not a closed report.
// `agents.activity` has `since` but no `to`, so the label says “Since”, never “period”. Guardian
// episodes are a separate source lane and are read only when their details are expanded.

export function ActivityTab({
  agentId,
  since,
  canAudit,
  agent,
  onChanged,
}: {
  agentId: string;
  since: string;
  canAudit: boolean;
  agent: AgentDetail;
  onChanged: () => void;
}) {
  const list = useApi(() => api.call('agents.activity', { agentId, since, limit: LIMIT }), [agentId, since], { skip: !canAudit });
  const [more, setMore] = useState<{ rows: AgentActionRow[]; next: number | null; loaded: boolean }>({
    rows: [],
    next: null,
    loaded: false,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkedAt = useFetchedAt(list.data);

  // A new `since` is a new ledger; pages loaded for the old bound no longer belong to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset paging whenever the bound changes, which the body does not read
  useEffect(() => {
    setMore({ rows: [], next: null, loaded: false });
    setMoreError(null);
    setAnnouncement('');
  }, [since]);

  if (!canAudit) {
    return (
      <Alert tone="info" title="Restricted by your role">
        The activity ledger needs audit access. No protected reads were made. Ask a workspace administrator for access.
      </Alert>
    );
  }

  if (list.refreshing || (list.loading && !list.data)) {
    return (
      <section aria-busy="true" aria-label="Loading agent activity" className="space-y-3">
        <p className="text-[13px] text-muted">Loading the activity ledger…</p>
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: loading placeholders are generated, never reordered, and have no identity
          <Skeleton key={i} className={i % 2 ? 'h-24 w-full' : 'h-20 w-11/12'} />
        ))}
      </section>
    );
  }

  if (list.error) {
    return (
      <Alert tone="bad" title="Couldn't load the activity ledger" onRetry={() => void list.reload()}>
        {list.error}
      </Alert>
    );
  }

  const data: AgentActivity | undefined = list.data;
  const firstPage = data?.actions ?? [];
  const actions = [...firstPage, ...more.rows];
  const next = more.loaded ? more.next : (data?.next ?? null);

  const loadMore = async () => {
    if (next === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.call('agents.activity', { agentId, since, limit: LIMIT, before: next });
      const shown = [...firstPage, ...more.rows, ...page.actions];
      setMore((current) => ({ rows: [...current.rows, ...page.actions], next: page.next, loaded: true }));
      setAnnouncement(`${shown.length} ${shown.length === 1 ? 'entry' : 'entries'} shown`);
      headingRef.current?.focus();
    } catch (e) {
      setMoreError(errText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0 space-y-4" aria-labelledby="agent-activity-heading">
        <div>
          <h2 id="agent-activity-heading" ref={headingRef} tabIndex={-1} className="text-[16px] leading-6 font-semibold">
            Activity · since {safeDateText(since)}
          </h2>
          <p className="mt-1 text-[12px] leading-[18px] text-muted">
            Newest first. This endpoint has no end bound, so this is a ledger view, not a closed report period.
            {checkedAt && ` Checked ${safeDateTimeText(checkedAt.toISOString())}.`}
          </p>
        </div>

        {actions.length === 0 ? (
          <EmptyState compact title={`No recorded activity since ${safeDateText(since)}`}>
            When this agent writes something, its decision, reasons and result appear here. Newer entries can appear as it acts.
          </EmptyState>
        ) : (
          <ol className="space-y-0">
            {actions.map((action) => (
              <TimelineEntry key={action.id} action={action} />
            ))}
          </ol>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {next !== null && (
            <Button loading={loadingMore} onClick={() => void loadMore()}>
              Load more actions
            </Button>
          )}
          <span className="text-[12px] text-muted">
            {intText(actions.length)} {actions.length === 1 ? 'entry' : 'entries'} shown
          </span>
        </div>
        {moreError && (
          <Alert tone="bad" title="Couldn't load more actions" onRetry={() => void loadMore()}>
            {moreError}
          </Alert>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </section>

      <aside className="min-w-0 space-y-4">
        {data && <CoordinationSummary data={data} />}
        <LazyGuardian agent={agent} onChanged={onChanged} />
        <LazyShadow agentId={agentId} />
      </aside>
    </div>
  );
}

function TimelineEntry({ action }: { action: AgentActionRow }) {
  const decision = DECISION[action.decision];
  const impact = impactText(action);
  return (
    <li className="relative border-l border-line pb-6 pl-5 last:pb-0">
      <span aria-hidden className="absolute top-1.5 -left-[4.5px] size-2 rounded-full bg-viz-2" />
      <div className="flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-muted">
        <time dateTime={action.at}>{safeDateTimeText(action.at)}</time>
        <span>· Action ledger</span>
        <DecisionBadge decision={action.decision} />
        {action.shadow && (
          <span title={action.shadow.reasons.join(' ')}>Shadow: {DECISION[action.shadow.decision].label.toLowerCase()}</span>
        )}
      </div>
      <h3 className="mt-1 text-[14px] leading-5 font-semibold">{action.intent || actionClassLabel(action.actionClass)}</h3>
      <p className="mt-1 text-[13px] leading-5 text-fg-2">
        {decision.label}
        {action.reasons.length ? ` · ${action.reasons.join(' · ')}` : ''}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[18px] text-muted">
        <span>{actionClassLabel(action.actionClass)}</span>
        {action.surface && <Tag>{action.surface}</Tag>}
        {action.target && (
          <span className="inline-flex min-w-0 items-center gap-1">
            Target <Identifier value={action.target} label="Target" />
          </span>
        )}
        {action.mandateId && action.mandateVersion !== null && (
          <Link to={artifactPath('agent_mandate', action.mandateId)} className="text-accent hover:underline">
            Mandate v{action.mandateVersion}
          </Link>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px]">
        {action.ok ? <StatusPill tone="good">Succeeded</StatusPill> : <StatusPill tone="bad">Failed</StatusPill>}
        {impact && <span className="text-fg-2">{impact}</span>}
        {!action.ok && action.error && <span className="break-words text-bad">{action.error}</span>}
      </div>
      <UndoEvidence action={action} />
    </li>
  );
}

function UndoEvidence({ action }: { action: AgentActionRow }) {
  if (action.undoneAt) {
    return (
      <p className="mt-1 text-[12px] leading-[18px] text-muted">
        Undone {safeDateTimeText(action.undoneAt)}
        {action.undoResult ? ` · ${action.undoResult}` : ''}
      </p>
    );
  }
  if (action.undoable) return <p className="mt-1 text-[12px] leading-[18px] text-muted">Can be undone.</p>;
  if (action.undoBlockedBy) return <p className="mt-1 text-[12px] leading-[18px] text-muted">{action.undoBlockedBy}</p>;
  return null;
}

function CoordinationSummary({ data }: { data: AgentActivity }) {
  const owned = data.ownedArtifacts ?? [];
  const conflicts = data.heldConflicts ?? [];
  return (
    <Card
      title="Ownership and coordination"
      description="A separate summary from the timeline: what this agent owns and which changes by other agents wait on it."
    >
      <div className="space-y-3 p-4 text-[12px] leading-[18px]">
        <p className="text-fg-2">
          Owns {intText(owned.length)} {owned.length === 1 ? 'artifact' : 'artifacts'}.
        </p>
        {conflicts.length === 0 ? (
          <p className="text-muted">No pending changes from other agents on those artifacts.</p>
        ) : (
          <ul className="space-y-2">
            {conflicts.map((conflict) => (
              <li key={`${conflict.artifactId}:${conflict.agentId}`} className="rounded-md border border-line px-3 py-2">
                <p className="font-medium text-fg">{conflict.artifactName}</p>
                <p className="text-muted">
                  {conflict.agentName} · {conflict.kind === 'hold' ? 'Inside its veto window' : 'Waiting for a person'}
                  {conflict.until ? ` · until ${safeDateTimeText(conflict.until)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted">
          Contact-pressure cap: {typeof data.contactPressureSkipped === 'number' ? intText(data.contactPressureSkipped) : 'Unavailable'}{' '}
          {data.contactPressureSkipped === 1 ? 'message' : 'messages'} skipped.
        </p>
      </div>
    </Card>
  );
}

function LazyGuardian({ agent, onChanged }: { agent: AgentDetail; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-line bg-surface" aria-label="Guardian">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-10 cursor-pointer items-center px-4 py-3 text-[13px] font-medium text-accent">
          Guardian episodes
        </summary>
        {open && (
          <div className="space-y-3 border-t border-line p-4">
            {!agent.guard && <p className="text-[12px] text-muted">No guardian cap is in force. Past episodes stay readable below.</p>}
            <GuardianCard agent={agent} onChanged={onChanged} />
          </div>
        )}
      </details>
    </section>
  );
}

function LazyShadow({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-line bg-surface" aria-label="Shadow results">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-10 cursor-pointer items-center px-4 py-3 text-[13px] font-medium text-accent">
          Shadow results
        </summary>
        {open && (
          <div className="border-t border-line p-4">
            <ShadowCard agentId={agentId} />
          </div>
        )}
      </details>
    </section>
  );
}
