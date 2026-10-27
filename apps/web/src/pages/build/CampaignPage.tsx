import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { CampaignEditor } from '../../features/artifacts/CampaignEditor';
import { CampaignHoldoutCard } from '../../features/campaigns/CampaignHoldoutCard';
import { CampaignEvaluation } from '../../features/artifacts/CampaignEvaluation';

export default function CampaignPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Campaigns', to: '/build/campaigns' }]}
      wide
      editor={(p) => <CampaignEditor {...p} />}
      extraTabs={[
        {
          key: 'evaluation',
          label: 'Evaluation',
          render: (a) => (
            <div className="space-y-4">
              <CampaignEvaluation campaignId={a.id} />
              <CampaignHoldoutCard campaignId={a.id} />
            </div>
          ),
        },
      ]}
    />
  );
}
