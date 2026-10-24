import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';

/** Types without a page of their own (SMS and push templates, tracking plan, delivery policy…). */
export default function ArtifactPage({ params }: { params: Record<string, string> }) {
  return <ArtifactDetailPage id={params.id} crumbs={[]} />;
}
