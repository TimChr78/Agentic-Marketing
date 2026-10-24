import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function WorkspacePage() {
  useCrumbs([{ label: 'WorkspacePage' }]);
  return <EmptyState title="WorkspacePage">Not built yet.</EmptyState>;
}
