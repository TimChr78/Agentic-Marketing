import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function ImportsPage() {
  useCrumbs([{ label: 'ImportsPage' }]);
  return <EmptyState title="ImportsPage">Not built yet.</EmptyState>;
}
