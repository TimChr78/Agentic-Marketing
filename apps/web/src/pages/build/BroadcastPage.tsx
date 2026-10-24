import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { BroadcastEditor } from '../../features/artifacts/BroadcastEditor';

export default function BroadcastPage({ params }: { params: Record<string, string> }) {
  return <ArtifactDetailPage id={params.id} crumbs={[{ label: 'Broadcasts', to: '/build/broadcasts' }]} editor={(p) => <BroadcastEditor {...p} />} />;
}
