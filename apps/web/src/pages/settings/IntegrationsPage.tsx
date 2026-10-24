import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function IntegrationsPage() {
  useCrumbs([{ label: 'IntegrationsPage' }]);
  return <EmptyState title="IntegrationsPage">Not built yet.</EmptyState>;
}
