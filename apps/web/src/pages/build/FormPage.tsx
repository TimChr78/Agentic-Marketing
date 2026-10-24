import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function FormPage() {
  useCrumbs([{ label: 'FormPage' }]);
  return <EmptyState title="FormPage">Not built yet.</EmptyState>;
}
