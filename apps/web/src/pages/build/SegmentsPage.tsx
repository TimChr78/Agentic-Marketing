import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function SegmentsPage() {
  useCrumbs([{ label: 'SegmentsPage' }]);
  return <EmptyState title="SegmentsPage">Not built yet.</EmptyState>;
}
