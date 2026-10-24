import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function AssetsPage() {
  useCrumbs([{ label: 'AssetsPage' }]);
  return <EmptyState title="AssetsPage">Not built yet.</EmptyState>;
}
