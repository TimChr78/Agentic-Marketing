import { useCrumbs } from '../../app/page';
import { EmptyState } from '../../ui';

// TODO(v0.2): placeholder while the page is built.
export default function PreferencesPage() {
  useCrumbs([{ label: 'PreferencesPage' }]);
  return <EmptyState title="PreferencesPage">Not built yet.</EmptyState>;
}
