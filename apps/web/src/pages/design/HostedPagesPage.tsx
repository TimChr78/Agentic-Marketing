import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function HostedPagesPage() {
  useCrumbs([{ label: 'HostedPagesPage' }]);
  return <EmptyState title="HostedPagesPage">Not built yet.</EmptyState>;
}
