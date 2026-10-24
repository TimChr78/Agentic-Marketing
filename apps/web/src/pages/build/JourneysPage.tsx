import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function JourneysPage() {
  useCrumbs([{ label: 'JourneysPage' }]);
  return <EmptyState title="JourneysPage">Not built yet.</EmptyState>;
}
