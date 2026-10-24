import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function AiUsagePage() {
  useCrumbs([{ label: 'AiUsagePage' }]);
  return <EmptyState title="AiUsagePage">Not built yet.</EmptyState>;
}
