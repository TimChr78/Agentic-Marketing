import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function FormsPage() {
  useCrumbs([{ label: 'FormsPage' }]);
  return <EmptyState title="FormsPage">Not built yet.</EmptyState>;
}
