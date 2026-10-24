import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function TemplatesPage() {
  useCrumbs([{ label: 'TemplatesPage' }]);
  return <EmptyState title="TemplatesPage">Not built yet.</EmptyState>;
}
