import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function ExperiencePage() {
  useCrumbs([{ label: 'ExperiencePage' }]);
  return <EmptyState title="ExperiencePage">Not built yet.</EmptyState>;
}
