import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function PurposesPage() {
  useCrumbs([{ label: 'PurposesPage' }]);
  return <EmptyState title="PurposesPage">Not built yet.</EmptyState>;
}
