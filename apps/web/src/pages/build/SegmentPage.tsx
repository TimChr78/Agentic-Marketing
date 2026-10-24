import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function SegmentPage() {
  useCrumbs([{ label: 'SegmentPage' }]);
  return <EmptyState title="SegmentPage">Not built yet.</EmptyState>;
}
