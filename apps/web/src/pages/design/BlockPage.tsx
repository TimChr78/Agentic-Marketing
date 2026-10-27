import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { BlockEditor } from '../../features/blocks/BlockEditor';
import { BlockUsage } from '../../features/blocks/BlockUsage';

export default function BlockPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Blocks', to: '/design/blocks' }]}
      editor={(p) => <BlockEditor {...p} />}
      preview
      extraTabs={[{ key: 'usage', label: 'Used by', render: (a) => <BlockUsage artifactId={a.id} /> }]}
    />
  );
}
