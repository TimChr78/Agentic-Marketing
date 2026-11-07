import { Bot, Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { Link, navigate } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { usePageTab } from '../../app/useTab';
import { AgentControls } from '../../features/agents/AgentControls';
import { AgentStatusPill } from '../../features/agents/AgentStatus';
import { HostedAgentDialog } from '../../features/agents/HostedAgentDialog';
import { type Agent, credentialKinds } from '../../features/agents/labels';
import { ComparisonSection } from '../../features/agents/phase26/ComparisonSection';
import { Alert, Button, EmptyState, PageHeader, Table, TableFrame, Tabs, Td, THead, Th, Tr } from '../../ui';
import { pageWidth } from '../../ui/layout';
import PromptsPage from '../build/PromptsPage';

/** Work → Agents (#213, #215, #446, #509): who acts for this workspace, how to stop them. */
export function AgentsHome() {
  useCrumbs([{ label: 'Agents' }]);
  const { can } = useWorkspace();
  const canArtifacts = can('artifacts:read');
  const agents = useApi(() => api.call('agents.list', {}), [], { skip: !canArtifacts });
  const [creating, setCreating] = useState(false);
  const rows = agents.data?.agents ?? [];
  const admin = can('workspace:admin');
  const canAudit = can('audit:read');

  // Pause returns the updated agent, so the row changes without a second agents.list read.
  const replace = (updated: Agent) => {
    agents.setData((current) =>
      current ? { ...current, agents: current.agents.map((row) => (row.id === updated.id ? updated : row)) } : current,
    );
  };

  if (!canArtifacts) {
    return (
      <div className={pageWidth('default', 'space-y-5')}>
        <Alert tone="info" title="Restricted by your role">
          The agents list needs artifact access. No protected reads were made. Ask a workspace administrator for access.
        </Alert>
      </div>
    );
  }

  return (
    <div className={pageWidth('default', 'space-y-5')}>
      <PageHeader
        title="Agents"
        description="Every API token, connected MCP client and hosted run acts as an agent, with a person accountable for it. Pause is on every active row; revoke ends an agent for good."
        actions={
          admin && (
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
              New hosted agent
            </Button>
          )
        }
      />

      {creating && (
        <HostedAgentDialog
          onClose={() => setCreating(false)}
          onSaved={(agentId) => {
            void agents.reload();
            navigate(`/work/agents/${agentId}`);
          }}
        />
      )}

      <TableFrame
        loading={agents.loading}
        error={agents.error}
        onRetry={agents.reload}
        columns={5}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={<Bot size={20} />}
            title="No agents yet"
            action={
              <ButtonLink to="/settings/integrations" variant="primary">
                Create an API token
              </ButtonLink>
            }
          >
            An agent appears the first time a token or MCP client acts in this workspace. Create a token for an agent such as Hermes,
            connect one over MCP, or let the platform run one for you with New hosted agent.
          </EmptyState>
        }
      >
        <Table label="Agents">
          <THead>
            <tr>
              <Th>Agent</Th>
              <Th className="hidden md:table-cell">Sponsor</Th>
              <Th>Status</Th>
              <Th className="hidden lg:table-cell">Credentials</Th>
              <Th>Last 24 hours</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((a: Agent) => (
              <Tr key={a.id}>
                <Td>
                  <Link to={`/work/agents/${a.id}`} className="font-medium text-fg hover:underline">
                    {a.name}
                  </Link>
                  {a.description && <div className="mt-0.5 line-clamp-1 max-w-[360px] text-[12px] text-muted">{a.description}</div>}
                  {admin && (
                    <div className="mt-1.5">
                      <AgentControls agent={a} variant="menu" onUpdated={replace} />
                    </div>
                  )}
                </Td>
                <Td className="hidden md:table-cell">{a.sponsor.name}</Td>
                <Td>
                  <AgentStatusPill status={a.status} guard={a.guard} statusReason={a.statusReason} />
                  {a.status === 'paused' && a.statusReason && (
                    <div className="mt-0.5 max-w-[220px] text-[11px] text-muted">{a.statusReason}</div>
                  )}
                </Td>
                <Td className="hidden lg:table-cell">
                  <div>{a.credentials.length === 1 ? '1 credential' : `${a.credentials.length} credentials`}</div>
                  <div className="text-[11px] text-muted break-words">{credentialKinds(a) || 'None yet'}</div>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="text-[12px]">
                    {a.last24h.changes} change{a.last24h.changes === 1 ? '' : 's'} · {a.last24h.escalated} escalated · {a.last24h.denied}{' '}
                    denied
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>

      <ComparisonSection agents={rows} canAudit={canAudit} />
    </div>
  );
}

const AGENT_TABS = ['agents', 'library'] as const;
type AgentTab = (typeof AGENT_TABS)[number];

const AGENT_TAB_ITEMS: { key: AgentTab; label: string }[] = [
  { key: 'agents', label: 'Agents' },
  { key: 'library', label: 'Library' },
];

/** Work → Agents (#446): the agent inventory and the existing AI prompt library as named tabs. */
export default function AgentsPage() {
  const { active, invalid, select } = usePageTab({ keys: AGENT_TABS, fallback: 'agents' });
  useCrumbs([{ label: active === 'library' ? 'AI prompts' : 'Agents' }]);

  return (
    <div className={pageWidth('default')}>
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={AGENT_TAB_ITEMS} value={active} onChange={select} label="Agents">
        {active === 'library' ? <PromptsPage /> : <AgentsHome />}
      </Tabs>
    </div>
  );
}
