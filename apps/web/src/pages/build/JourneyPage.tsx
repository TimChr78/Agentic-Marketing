import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { CampaignMembership } from '../../features/artifacts/CampaignMembership';
import { JourneyBuilder } from '../../features/journey/Builder';

export default function JourneyPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Journeys', to: '/build/journeys' }]}
      wide
      autosave
      description={<CampaignMembership artifactId={params.id} />}
      editor={(p) => <JourneyBuilder {...p} />}
    />
  );
}
