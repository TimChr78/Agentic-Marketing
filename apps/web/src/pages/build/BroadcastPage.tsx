import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { BroadcastEditor } from '../../features/artifacts/BroadcastEditor';
import { BroadcastStatus } from '../../features/artifacts/BroadcastStatus';
import { CampaignMembership } from '../../features/artifacts/CampaignMembership';

export default function BroadcastPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Broadcasts', to: '/build/broadcasts' }]}
      wide
      description={<CampaignMembership artifactId={params.id} />}
      editor={(p) => <BroadcastEditor {...p} />}
      extraTabs={[{ key: 'sending', label: 'Sending', render: (a) => <BroadcastStatus artifact={a} /> }]}
    />
  );
}
