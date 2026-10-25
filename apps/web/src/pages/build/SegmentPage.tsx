import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { SegmentEditor } from '../../features/artifacts/SegmentEditor';

export default function SegmentPage({ params }: { params: Record<string, string> }) {
  return <ArtifactDetailPage id={params.id} crumbs={[{ label: 'Segments', to: '/build/segments' }]} editor={(p) => <SegmentEditor {...p} />} />;
}
