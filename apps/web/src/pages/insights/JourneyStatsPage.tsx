import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function JourneyStatsPage() {
  useCrumbs([{ label: 'JourneyStatsPage' }]);
  return <EmptyState title="JourneyStatsPage">Not built yet.</EmptyState>;
}
