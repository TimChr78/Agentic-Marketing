import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';

export default function ExperiencePage({ params }: { params: Record<string, string> }) {
  return <ArtifactDetailPage id={params.id} crumbs={[{ label: 'Experiences', to: '/build/experiences' }]} />;
}
