import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function ApprovalsPage() {
  useCrumbs([{ label: 'ApprovalsPage' }]);
  return <EmptyState title="ApprovalsPage">Not built yet.</EmptyState>;
}
