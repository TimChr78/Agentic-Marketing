import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function MessagesPage() {
  useCrumbs([{ label: 'MessagesPage' }]);
  return <EmptyState title="MessagesPage">Not built yet.</EmptyState>;
}
