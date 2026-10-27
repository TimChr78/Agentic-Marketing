import { EmptyState } from '../../ui';
import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { CampaignEditor } from '../../features/artifacts/CampaignEditor';
import { CampaignHoldoutCard } from '../../features/campaigns/CampaignHoldoutCard';

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
          render: () => (
            <div className="space-y-4">
              <EmptyState compact title="Results arrive with campaign evaluation">
                The funnel and results for this campaign’s goal will appear here once campaign evaluation lands. Until then, read the members’ own
                stats.
              </EmptyState>
              {/* campaign holdout card */}
              <CampaignHoldoutCard campaignId={params.id} />
            </div>
          ),
        },
      ]}
    />
  );
}
