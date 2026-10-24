import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function PeoplePage() {
  useCrumbs([{ label: 'PeoplePage' }]);
  return <EmptyState title="PeoplePage">Not built yet.</EmptyState>;
}
