import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function ArtifactPage() {
  useCrumbs([{ label: 'ArtifactPage' }]);
  return <EmptyState title="ArtifactPage">Not built yet.</EmptyState>;
}
