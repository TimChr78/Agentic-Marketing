import { Bot } from 'lucide-react';
import { api } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { AgentControls } from '../../features/agents/AgentControls';
import { AgentStatusPill } from '../../features/agents/AgentStatus';
import { AutonomyCard } from '../../features/agents/AutonomyCard';
import { useAutonomy } from '../../features/agents/AutonomyProvider';
import { type Agent, credentialKinds } from '../../features/agents/labels';
import { Alert, Card, EmptyState, LoadingBlock, PageHeader, Table, TableFrame, Td, THead, Th, Tr, useToast } from '../../ui';
import { pageWidth } from '../../ui/layout';

/** Settings → Agents (#213, #215): who acts for this workspace, how to stop them, and the ceilings. */
export default function AgentsPage() {
  useCrumbs([{ label: 'Agents' }]);
  const { can } = useWorkspace();
  const toast = useToast();
  const agents = useApi(() => api.call('agents.list', {}), []);
  const autonomy = useAutonomy();
  const rows = agents.data?.agents ?? [];
  const admin = can('workspace:admin');

  return (
    <div className={pageWidth('default', 'space-y-5')}>
      <PageHeader
        title="Agents"
        description="Every API token and connected MCP client acts as an agent, with a person accountable for it. Pause or revoke one to stop it at once; its sponsor and its history stay."
      />

      <TableFrame
        loading={agents.loading}
        error={agents.error}
        onRetry={agents.reload}
        columns={admin ? 6 : 5}
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
            An agent appears the first time a token or MCP client acts in this workspace. Create a token for an agent such as Hermes, or
            connect one over MCP.
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
              {admin && (
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              )}
            </tr>
          </THead>
          <tbody>
            {rows.map((a: Agent) => (
              <Tr key={a.id}>
                <Td>
                  <Link to={`/settings/agents/${a.id}`} className="font-medium text-fg hover:underline">
                    {a.name}
                  </Link>
                  {a.description && <div className="mt-0.5 line-clamp-1 max-w-[360px] text-[12px] text-muted">{a.description}</div>}
                </Td>
                <Td className="hidden md:table-cell">{a.sponsor.name}</Td>
                <Td>
                  <AgentStatusPill status={a.status} />
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
                {admin && (
                  <Td className="text-right">
                    <AgentControls agent={a} variant="menu" onChanged={() => void agents.reload()} />
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>

      {autonomy.loading && !autonomy.settings ? (
        <Card title="Autonomy">
          <LoadingBlock lines={4} label="Loading autonomy settings" />
        </Card>
      ) : autonomy.error && !autonomy.settings ? (
        <Alert tone="bad" title="Couldn't load autonomy settings" onRetry={() => void autonomy.reload()}>
          {autonomy.error}
        </Alert>
      ) : autonomy.settings ? (
        <AutonomyCard
          settings={autonomy.settings}
          canEdit={admin}
          onSave={async (patch) => {
            await autonomy.save(patch);
            toast.success('Saved the autonomy settings. They apply to the next agent request.');
          }}
        />
      ) : null}
    </div>
  );
}
