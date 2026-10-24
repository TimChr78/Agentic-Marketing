import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function BroadcastPage() {
  useCrumbs([{ label: 'BroadcastPage' }]);
  return <EmptyState title="BroadcastPage">Not built yet.</EmptyState>;
}
