import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { ConnectAgentCard } from '../../features/integrations/ConnectAgentCard';
import { ConnectionsCard } from '../../features/integrations/ConnectionsCard';
import { SourcesCard } from '../../features/integrations/SourcesCard';
import { WebhooksCard } from '../../features/integrations/WebhooksCard';
import { TokensCard } from '../../features/tokens/TokensCard';
import { PageHeader } from '../../ui';

export default function IntegrationsPage({ params }: { params: Record<string, string> }) {
  useCrumbs([{ label: 'Integrations and API tokens', to: '/settings/integrations' }, ...(params.id ? [{ label: 'Token' }] : [])]);
  const { can } = useSession();
  return (
    <div className="space-y-5">
      <PageHeader title="Integrations and API tokens" description="How agents, scripts and other tools reach this workspace, and what they may do." />
      <TokensCard openId={params.id} />
      <ConnectAgentCard />
      {can('workspace:admin') && <SourcesCard />}
      {can('artifacts:read') && <WebhooksCard />}
      {can('artifacts:read') && <ConnectionsCard />}
    </div>
  );
}
