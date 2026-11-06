import { Link } from '../../app/router';
import { artifactTypeLabel } from '../../lib/labels';
import { stateOfAgent } from '../../lib/state';
import { cx } from '../../ui/cx';
import { Alert, StatusPill } from '../../ui/display';
import { Identifier } from '../../ui/Identifier';
import { OperationalPill } from '../../ui/state';
import { formatDateTime, timeAgo } from '../../ui/time';
import { RequesterView } from '../approvals/requester';
import { HomeBlock, HomeBlockEmpty, HomeBlockSkeleton, HomeSection } from './HomeSection';
import type { AgentsResult, AlertsResult, ApprovalsResult, FailuresResult, HomeData, Resource } from './useHomeData';

// Needs attention (#447): pending review and holds from one approvals page, firing alerts, guardian
// caps from the shared agent list, and recent failed hosted runs. The section title's count is the
// B7 total, never the number of groups that fit on Home.

type Approval = ApprovalsResult['approvals'][number];
type AlertRule = AlertsResult['rules'][number];
type Agent = AgentsResult['agents'][number];
type FailedRun = FailuresResult['runs'][number];

const MAX_GROUPS = 3;

interface ApprovalGroup {
  lead: Approval;
  partial: boolean;
}

function groupsOf(items: Approval[], loadedIds: Set<string>, hasCursor: boolean): ApprovalGroup[] {
  const groups = new Map<string, Approval[]>();
  for (const item of items) {
    const key = item.bundle?.id ?? item.id;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((members) => {
    const leadId = members[0].bundle?.members.at(-1)?.approvalId;
    const lead = members.find((member) => member.id === leadId) ?? members[0];
    const partial = hasCursor && (lead.bundle?.members.some((member) => !loadedIds.has(member.approvalId)) ?? false);
    return { lead, partial };
  });
}

function RequestRow({ group, held, canApprove, now }: { group: ApprovalGroup; held: boolean; canApprove: boolean; now: Date }) {
  const { lead, partial } = group;
  const bundleSize = lead.bundle?.members.length ?? 1;
  const passed = lead.holdUntil !== null && new Date(lead.holdUntil).getTime() <= now.getTime();
  return (
    <div className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
      <div className="min-w-0 flex-1">
        <Link to={`/approvals/${lead.id}`} className="text-[13px] leading-5 font-medium break-words text-fg hover:underline">
          {lead.artifactName}
        </Link>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-[18px] text-muted">
          <span>{artifactTypeLabel(lead.artifactType)}</span>
          <span aria-hidden>·</span>
          <span>v{lead.version}</span>
          <span aria-hidden>·</span>
          <span>requested by</span>
          <RequesterView r={lead.requester} className="text-fg-2" />
          <span aria-hidden>·</span>
          <span>{timeAgo(lead.createdAt, now.getTime())}</span>
        </p>
        {(bundleSize > 1 || partial) && (
          <p className="mt-1 text-[12px] leading-[18px] text-muted">
            {bundleSize > 1 ? `${bundleSize} changes in one bundle` : 'One bundle member'}
            {partial ? ' · More members in Approvals' : ''}
          </p>
        )}
        {lead.holdUntil && (
          <p className="mt-1 text-[12px] leading-[18px] text-warn">
            Window ends {formatDateTime(lead.holdUntil, { zone: true })}
            {passed ? ' · Window passed; awaiting recheck' : ''}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <OperationalPill
          state={
            held
              ? { key: 'held', label: 'Held', tone: 'warn', icon: 'hand' }
              : { key: 'in_review', label: 'In review', tone: 'warn', icon: 'clock' }
          }
        />
        <Link
          to={`/approvals/${lead.id}`}
          className="inline-flex min-h-10 items-center text-[12px] leading-[18px] text-accent hover:underline md:min-h-0"
        >
          {canApprove ? 'Review' : 'View request'}
        </Link>
      </div>
    </div>
  );
}

function RequestBlock({
  label,
  held,
  resource,
  now,
  canApprove,
  onRetry,
}: {
  label: string;
  held: boolean;
  resource: Resource<ApprovalsResult>;
  now: Date;
  canApprove: boolean;
  onRetry: () => void;
}) {
  const data = resource.data;
  if (data === undefined && resource.error !== null) {
    return (
      <HomeBlock label={label}>
        <div className="p-4">
          <Alert tone="bad" title={`Couldn't load ${held ? 'held requests' : 'pending reviews'}`} onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeBlock>
    );
  }
  if (data === undefined)
    return <HomeBlock label={label}>{<HomeBlockSkeleton label={held ? 'held requests' : 'pending reviews'} />}</HomeBlock>;

  const loadedIds = new Set(data.approvals.map((approval) => approval.id));
  const partition = data.approvals.filter((approval) => (held ? approval.holdUntil !== null : approval.holdUntil === null));
  const allGroups = groupsOf(partition, loadedIds, data.nextCursor !== null);
  const groups = allGroups.slice(0, MAX_GROUPS);
  const hasMore = allGroups.length > MAX_GROUPS;

  let empty: string | null = null;
  if (data.total === 0) empty = 'No pending requests';
  else if (groups.length === 0)
    empty = data.nextCursor
      ? `No ${held ? 'holds' : 'reviews'} in the oldest 20 loaded requests`
      : held
        ? 'No held requests'
        : 'No pending reviews';

  return (
    <HomeBlock
      label={label}
      footer={
        groups.length > 0 && (hasMore || data.nextCursor) ? (
          <Link to="/approvals" className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0">
            View all in Approvals
          </Link>
        ) : empty && data.nextCursor ? (
          <Link to="/approvals" className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0">
            View Approvals
          </Link>
        ) : undefined
      }
    >
      {empty ? (
        <HomeBlockEmpty>{empty}</HomeBlockEmpty>
      ) : (
        groups.map((group) => <RequestRow key={group.lead.id} group={group} held={held} canApprove={canApprove} now={now} />)
      )}
    </HomeBlock>
  );
}

function firingAlerts(rules: AlertRule[]): AlertRule[] {
  return rules
    .filter((rule) => rule.enabled && rule.state === 'firing')
    .sort((a, b) => {
      const at = a.firingSince ? new Date(a.firingSince).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.firingSince ? new Date(b.firingSince).getTime() : Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
}

function AlertRows({ resource, onRetry }: { resource: Resource<AlertsResult>; onRetry: () => void }) {
  if (resource.data === undefined && resource.error !== null)
    return (
      <HomeBlock label="Firing alerts">
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load firing alerts" onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeBlock>
    );
  if (resource.data === undefined) return <HomeBlock label="Firing alerts">{<HomeBlockSkeleton label="firing alerts" />}</HomeBlock>;
  const rules = firingAlerts(resource.data.rules).slice(0, 3);
  return (
    <HomeBlock label="Firing alerts">
      {rules.length === 0 ? (
        <HomeBlockEmpty>No firing alerts</HomeBlockEmpty>
      ) : (
        rules.map((rule) => (
          <div key={rule.id} className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
            <div className="min-w-0 flex-1">
              <Link to="/insights/alerts" className="text-[13px] leading-5 font-medium break-words text-fg hover:underline">
                {rule.name}
              </Link>
              <p className="mt-1 text-[12px] leading-[18px] text-muted">
                {rule.firingSince ? `Firing since ${formatDateTime(rule.firingSince, { zone: true })}` : 'Firing since unavailable'}
              </p>
            </div>
            <StatusPill tone="bad">Firing</StatusPill>
          </div>
        ))
      )}
    </HomeBlock>
  );
}

function guardianCaps(agents: Agent[]): Agent[] {
  return agents
    .filter((agent) => typeof agent.guard?.cap === 'number')
    .sort((a, b) => {
      const at = a.guard?.since ? new Date(a.guard.since).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.guard?.since ? new Date(b.guard.since).getTime() : Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
}

function CapRows({ resource, onRetry }: { resource: Resource<AgentsResult>; onRetry: () => void }) {
  if (resource.data === undefined && resource.error !== null)
    return (
      <HomeBlock label="Guardian caps">
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load guardian caps" onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeBlock>
    );
  if (resource.data === undefined) return <HomeBlock label="Guardian caps">{<HomeBlockSkeleton label="guardian caps" />}</HomeBlock>;
  const agents = guardianCaps(resource.data.agents).slice(0, 3);
  return (
    <HomeBlock label="Guardian caps">
      {agents.length === 0 ? (
        <HomeBlockEmpty>No guardian caps</HomeBlockEmpty>
      ) : (
        agents.map((agent) => (
          <div key={agent.id} className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
            <div className="min-w-0 flex-1">
              <Link
                to={`/work/agents/${encodeURIComponent(agent.id)}`}
                className="text-[13px] leading-5 font-medium break-words text-fg hover:underline"
              >
                {agent.name}
              </Link>
              <p className="mt-1 text-[12px] leading-[18px] text-muted">
                Guardian cap {agent.guard?.cap} ·{' '}
                {agent.guard?.since ? `since ${formatDateTime(agent.guard.since, { zone: true })}` : 'since unavailable'}
                {agent.guard?.reason ? ` · ${agent.guard.reason}` : ''}
              </p>
            </div>
            <OperationalPill state={stateOfAgent({ status: agent.status, statusReason: agent.statusReason, guard: agent.guard })} />
          </div>
        ))
      )}
    </HomeBlock>
  );
}

function FailureRows({ resource, onRetry }: { resource: Resource<FailuresResult>; onRetry: () => void }) {
  if (resource.data === undefined && resource.error !== null)
    return (
      <HomeBlock label="Recent failed hosted runs" meta="Failed in the last 7 days">
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load recent failed hosted runs" onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeBlock>
    );
  if (resource.data === undefined)
    return (
      <HomeBlock label="Recent failed hosted runs" meta="Failed in the last 7 days">
        {<HomeBlockSkeleton label="recent failed hosted runs" />}
      </HomeBlock>
    );
  const runs = resource.data.runs.slice(0, 3);
  return (
    <HomeBlock
      label="Recent failed hosted runs"
      meta="Failed in the last 7 days"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted">As of {formatDateTime(resource.data.asOf, { zone: true })}</span>
          {resource.data.nextCursor && (
            <Link to="/work/agents" className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0">
              More recent failures
            </Link>
          )}
        </div>
      }
    >
      {runs.length === 0 ? (
        <HomeBlockEmpty>No failed hosted runs in the last 7 days</HomeBlockEmpty>
      ) : (
        runs.map((run: FailedRun) => (
          <div key={run.id} className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
            <div className="min-w-0 flex-1">
              <Link
                to={`/work/agents/${encodeURIComponent(run.agentId)}`}
                className="text-[13px] leading-5 font-medium break-words text-fg hover:underline"
              >
                {run.agentName}
              </Link>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-muted">
                <span>{formatDateTime(run.startedAt, { zone: true })}</span>
                <Identifier value={run.id} label="Run ID" />
              </p>
              {(run.error ?? run.summary) && (
                <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-fg-2" title={run.error ?? run.summary}>
                  {run.error ?? run.summary}
                </p>
              )}
            </div>
            <StatusPill tone="bad">Failed</StatusPill>
          </div>
        ))
      )}
    </HomeBlock>
  );
}

export function HomeAttention({
  data,
  can,
}: {
  data: Pick<HomeData, 'resources' | 'clock' | 'retry'>;
  can: (permission: string) => boolean;
}) {
  const { resources, clock, retry } = data;
  const approvals = resources.approvals.data;
  const pendingMeta = approvals
    ? `${approvals.total} pending ${approvals.total === 1 ? 'request' : 'requests'}${approvals.nextCursor ? ' · oldest 20 loaded' : ''}`
    : undefined;
  return (
    <HomeSection title="Needs attention" meta={pendingMeta}>
      <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-line">
        <div className="divide-y divide-line">
          <RequestBlock
            label="Pending review"
            held={false}
            resource={resources.approvals}
            now={clock.now}
            canApprove={can('artifacts:approve')}
            onRetry={() => void retry.approvals()}
          />
          <RequestBlock
            label="Holds"
            held
            resource={resources.approvals}
            now={clock.now}
            canApprove={can('artifacts:approve')}
            onRetry={() => void retry.approvals()}
          />
        </div>
        <div className={cx('divide-y divide-line border-t border-line lg:border-t-0')}>
          <AlertRows resource={resources.alerts} onRetry={() => void retry.alerts()} />
          <CapRows resource={resources.agents} onRetry={() => void retry.agents()} />
          <FailureRows resource={resources.failures} onRetry={() => void retry.failures()} />
        </div>
      </div>
    </HomeSection>
  );
}
