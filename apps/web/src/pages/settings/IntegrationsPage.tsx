import { useState } from 'react';
import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { ConnectAgentCard } from '../../features/integrations/ConnectAgentCard';
import { ConnectionsCard } from '../../features/integrations/ConnectionsCard';
import { SourcesCard } from '../../features/integrations/SourcesCard';
import { WebhooksCard } from '../../features/integrations/WebhooksCard';
import { TokensCard } from '../../features/tokens/TokensCard';
import { PageHeader, Tabs } from '../../ui';
import { pageWidth } from '../../ui/layout';

type Section = 'tokens' | 'agent' | 'sources' | 'webhooks' | 'connections';

/**
 * Integrations and API tokens (#527): a local section selector that mounts only the chosen
 * section, so each switch reads only that section's data. A token deep link keeps working and
 * opens its drawer inside the API tokens section.
 */
export default function IntegrationsPage({ params }: { params: Record<string, string> }) {
  useCrumbs([{ label: 'Integrations and API tokens', to: '/settings/integrations' }, ...(params.id ? [{ label: 'Token' }] : [])]);
  const { can } = useSession();
  const [selected, setSelected] = useState<Section>('tokens');

  const items: { key: Section; label: string }[] = [
    { key: 'tokens', label: 'API tokens' },
    { key: 'agent', label: 'Connect an agent' },
    ...(can('workspace:admin') ? [{ key: 'sources' as const, label: 'Event sources' }] : []),
    ...(can('artifacts:read') ? [{ key: 'webhooks' as const, label: 'Webhooks' }] : []),
    ...(can('artifacts:read') ? [{ key: 'connections' as const, label: 'Connections' }] : []),
  ];

  // A token deep link always opens the token drawer, even when the page still holds another section.
  const active: Section = params.id ? 'tokens' : items.some((i) => i.key === selected) ? selected : items[0]!.key;

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Integrations and API tokens"
        description="How agents, scripts and other tools reach this workspace, and what they may do. Choose one section; its data loads when you open it."
      />
      <Tabs items={items} value={active} onChange={setSelected} label="Integration sections">
        {active === 'tokens' && <TokensCard openId={params.id} />}
        {active === 'agent' && <ConnectAgentCard />}
        {active === 'sources' && <SourcesCard />}
        {active === 'webhooks' && <WebhooksCard />}
        {active === 'connections' && <ConnectionsCard />}
      </Tabs>
    </div>
  );
}
