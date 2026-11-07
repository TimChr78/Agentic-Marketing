import { useEffect, useMemo, useState } from 'react';
import { api } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { AgentControls } from '../../features/agents/AgentControls';
import { AgentStatusPill } from '../../features/agents/AgentStatus';
import { ActivityTab } from '../../features/agents/phase26/ActivityTab';
import { CredentialsTab } from '../../features/agents/phase26/CredentialsTab';
import { MandateTab } from '../../features/agents/phase26/MandateTab';
import { isNotFound } from '../../features/agents/phase26/model';
import { OverviewTab } from '../../features/agents/phase26/OverviewTab';
import { type ReportPeriodChoice, reportPeriod } from '../../features/broadcasts/period';
import { Alert, EmptyState, LoadingBlock, PageHeader, Tabs } from '../../ui';
import { Identifier } from '../../ui/Identifier';
import { pageWidth } from '../../ui/layout';

const AGENT_TABS = ['overview', 'activity', 'mandate', 'credentials'] as const;
type AgentTab = (typeof AGENT_TABS)[number];

const TAB_ITEMS: { key: AgentTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'mandate', label: 'Mandate' },
  { key: 'credentials', label: 'Credentials' },
];

/**
 * One agent (#213, #509): Overview / Activity / Mandate / Credentials. Pause is always one click
 * away in the header across every tab; the page fetches the agent once and each tab reads only
 * what it shows. No artifact scans, no per-mandate fan-out and no separate workspace.get call.
 */
export default function AgentPage({ params }: { params: Record<string, string> }) {
  const id = params.id ?? '';
  const { can } = useWorkspace();
  const canArtifacts = can('artifacts:read');
  const canAudit = can('audit:read');
  const agent = useApi(() => api.call('agents.get', { id }), [id], { skip: !canArtifacts });
  const [tab, setTab] = useState<AgentTab>('overview');
  const [choice, setChoice] = useState<ReportPeriodChoice>(7);
  const [anchor, setAnchor] = useState(() => new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  const period = useMemo(() => reportPeriod(choice, anchor), [choice, anchor]);

  // A different agent is a different page: start on Overview and the default period.
  useEffect(() => {
    setTab('overview');
    setChoice(7);
    setAnchor(new Date());
    setRefreshKey(0);
  }, [id]);

  useCrumbs([{ label: 'Agents', to: '/work/agents' }, { label: agent.data?.name ?? 'Agent' }]);

  if (!canArtifacts) {
    return (
      <div className={pageWidth('default')}>
        <Alert tone="info" title="Restricted by your role">
          The agent page needs artifact access. No protected reads were made. Ask a workspace administrator for access.
        </Alert>
      </div>
    );
  }

  if (agent.loading && !agent.data) {
    return (
      <div className={pageWidth('default')}>
        <LoadingBlock lines={6} label="Loading agent" />
      </div>
    );
  }

  if (agent.error && !agent.data && isNotFound(agent.error)) {
    return (
      <div className={pageWidth('default')}>
        <EmptyState
          title="Agent not found"
          action={
            <ButtonLink to="/work/agents" variant="secondary">
              Return to the agents list
            </ButtonLink>
          }
        >
          This item is not available at this address. It may have been removed, or the address is mistyped.
        </EmptyState>
      </div>
    );
  }

  if (agent.error && !agent.data) {
    return (
      <div className={pageWidth('default')}>
        <Alert tone="bad" title="Couldn't load this agent" onRetry={() => void agent.reload()}>
          {agent.error}
        </Alert>
      </div>
    );
  }

  if (!agent.data) {
    return (
      <div className={pageWidth('default')}>
        <EmptyState title="Agent not found">This item is not available at this address. Return to the list.</EmptyState>
      </div>
    );
  }

  const a = agent.data;
  const changeChoice = (next: ReportPeriodChoice) => {
    setAnchor(new Date());
    setChoice(next);
  };
  const refresh = () => {
    setAnchor(new Date());
    setRefreshKey((value) => value + 1);
  };

  return (
    <div className={pageWidth('default', 'space-y-5')}>
      <PageHeader
        title={a.name}
        meta={
          <>
            <AgentStatusPill status={a.status} guard={a.guard} statusReason={a.statusReason} />
            <span>Sponsored by {a.sponsor.name}</span>
            <Identifier value={a.id} label="Agent ID" />
          </>
        }
        description={a.description || 'An agent acts for this workspace through its API token or MCP client.'}
        // Pause is a single click at every width and on every tab; no modal and no mandatory reason.
        actions={<AgentControls agent={a} onUpdated={(updated) => agent.setData(updated)} />}
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

      <Tabs items={TAB_ITEMS} value={tab} onChange={setTab} label="Agent sections">
        {tab === 'overview' && (
          <OverviewTab
            agentId={a.id}
            period={period}
            choice={choice}
            canAudit={canAudit}
            refreshKey={refreshKey}
            onChoiceChange={changeChoice}
            onRefresh={refresh}
          />
        )}
        {tab === 'activity' && <ActivityTab agentId={a.id} since={period.from} canAudit={canAudit} guard={a.guard} />}
        {tab === 'mandate' && <MandateTab agentId={a.id} agent={a} canArtifacts={canArtifacts} />}
        {tab === 'credentials' && <CredentialsTab agent={a} canArtifacts={canArtifacts} />}
      </Tabs>
    </div>
  );
}
