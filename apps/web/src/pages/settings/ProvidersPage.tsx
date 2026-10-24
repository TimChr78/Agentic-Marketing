import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function ProvidersPage() {
  useCrumbs([{ label: 'ProvidersPage' }]);
  return <EmptyState title="ProvidersPage">Not built yet.</EmptyState>;
}
