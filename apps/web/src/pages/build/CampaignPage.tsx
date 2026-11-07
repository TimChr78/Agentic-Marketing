import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { CampaignEditor } from '../../features/artifacts/CampaignEditor';
import { CampaignEvaluationTab } from '../../features/campaigns/phase26/CampaignEvaluationTab';

export default function CampaignPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Campaigns', to: '/marketing/campaigns' }]}
      wide
      editor={(p) => <CampaignEditor {...p} />}
      extraTabs={[
        {
          key: 'evaluation',
          label: 'Evaluation',
          render: (a) => <CampaignEvaluationTab campaignId={a.id} artifact={a} active />,
        },
      ]}
    />
  );
}
