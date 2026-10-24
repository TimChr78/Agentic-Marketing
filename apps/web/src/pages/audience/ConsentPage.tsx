import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function ConsentPage() {
  useCrumbs([{ label: 'ConsentPage' }]);
  return <EmptyState title="ConsentPage">Not built yet.</EmptyState>;
}
