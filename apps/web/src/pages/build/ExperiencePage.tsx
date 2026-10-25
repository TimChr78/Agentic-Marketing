import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { ExperienceResults } from '../../features/artifacts/ExperienceResults';

export default function ExperiencePage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Experiences', to: '/build/experiences' }]}
      extraTabs={[{ key: 'results', label: 'Results', render: (a) => <ExperienceResults artifact={a} /> }]}
    />
  );
}
