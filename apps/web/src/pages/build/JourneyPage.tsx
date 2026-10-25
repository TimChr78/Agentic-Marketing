import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { JourneyBuilder } from '../../features/journey/Builder';

export default function JourneyPage({ params }: { params: Record<string, string> }) {
  return <ArtifactDetailPage id={params.id} crumbs={[{ label: 'Journeys', to: '/build/journeys' }]} wide autosave editor={(p) => <JourneyBuilder {...p} />} />;
}
