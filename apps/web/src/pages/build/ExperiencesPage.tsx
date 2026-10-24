import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function ExperiencesPage() {
  useCrumbs([{ label: 'ExperiencesPage' }]);
  return <EmptyState title="ExperiencesPage">Not built yet.</EmptyState>;
}
