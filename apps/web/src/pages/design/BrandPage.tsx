import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function BrandPage() {
  useCrumbs([{ label: 'BrandPage' }]);
  return <EmptyState title="BrandPage">Not built yet.</EmptyState>;
}
