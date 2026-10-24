import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function UsersPage() {
  useCrumbs([{ label: 'UsersPage' }]);
  return <EmptyState title="UsersPage">Not built yet.</EmptyState>;
}
