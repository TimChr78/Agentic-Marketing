import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function PersonPage() {
  useCrumbs([{ label: 'PersonPage' }]);
  return <EmptyState title="PersonPage">Not built yet.</EmptyState>;
}
