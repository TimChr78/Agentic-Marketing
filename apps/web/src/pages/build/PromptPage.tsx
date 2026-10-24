import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';

export default function PromptPage({ params }: { params: Record<string, string> }) {
  return <ArtifactDetailPage id={params.id} crumbs={[{ label: 'AI prompts', to: '/build/prompts' }]} />;
}
