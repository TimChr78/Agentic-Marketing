import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function PromptsPage() {
  useCrumbs([{ label: 'PromptsPage' }]);
  return <EmptyState title="PromptsPage">Not built yet.</EmptyState>;
}
