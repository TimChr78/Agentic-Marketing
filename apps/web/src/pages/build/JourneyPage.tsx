import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function JourneyPage() {
  useCrumbs([{ label: 'JourneyPage' }]);
  return <EmptyState title="JourneyPage">Not built yet.</EmptyState>;
}
