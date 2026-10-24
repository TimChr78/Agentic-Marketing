import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function SecretsPage() {
  useCrumbs([{ label: 'SecretsPage' }]);
  return <EmptyState title="SecretsPage">Not built yet.</EmptyState>;
}
