import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function PromptPage() {
  useCrumbs([{ label: 'PromptPage' }]);
  return <EmptyState title="PromptPage">Not built yet.</EmptyState>;
}
