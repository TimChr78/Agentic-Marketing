import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { FormEditor } from '../../features/artifacts/FormEditor';

export default function FormPage({ params }: { params: Record<string, string> }) {
  return <ArtifactDetailPage id={params.id} crumbs={[{ label: 'Forms', to: '/build/forms' }]} wide editor={(p) => <FormEditor {...p} />} />;
}
