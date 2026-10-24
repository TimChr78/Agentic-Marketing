import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function DeliverabilityPage() {
  useCrumbs([{ label: 'DeliverabilityPage' }]);
  return <EmptyState title="DeliverabilityPage">Not built yet.</EmptyState>;
}
