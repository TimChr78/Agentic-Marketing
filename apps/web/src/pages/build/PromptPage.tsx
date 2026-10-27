import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { PromptEditor } from '../../features/artifacts/PromptEditor';
import { PromptTests } from '../../features/artifacts/PromptTests';

export default function PromptPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'AI prompts', to: '/build/prompts' }]}
      wide
      editor={(p) => <PromptEditor {...p} />}
      extraTabs={[{ key: 'tests', label: 'Tests', render: (a) => <PromptTests artifact={a} /> }]}
    />
  );
}
