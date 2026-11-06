import { useLocation } from '../../app/router';
import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';

export default function JourneysPage() {
  const { search } = useLocation();
  // The old Journey stats destination redirects here (`?view=reports`): the same list, with the
  // message that a journey opens its Report tab, and row links that select that tab.
  const reports = search.get('view') === 'reports';
  const invalid = search.get('invalidJourney') === '1';
  return (
    <ArtifactListPage
      type="journey"
      title="Journeys"
      description={
        reports
          ? `${invalid ? 'Choose a valid journey. ' : ''}Choose a journey to open its report. Automated paths: a trigger, then messages, waits, branches and AI steps.`
          : 'Automated paths: a trigger, then messages, waits, branches and AI steps. Build them on a canvas or let an agent draft them; people approve.'
      }
      rowHref={reports ? (a) => `/marketing/journeys/${a.id}?tab=report` : undefined}
      emptyTitle="No journeys yet"
      emptyText="Create a welcome series that starts when someone confirms their subscription. Agents can draft journeys too."
      create={{
        label: 'New journey',
        content: () => ({
          purpose: 'marketing_email',
          nodes: [
            {
              id: 'n1',
              kind: 'trigger',
              label: 'Confirmed subscription',
              config: { event: 'Subscription Confirmed', reentry: 'once' },
              next: [{ to: 'n2' }],
              position: { x: 0, y: 0 },
            },
            { id: 'n2', kind: 'exit', label: 'Exit', config: {}, next: [], position: { x: 0, y: 200 } },
          ],
        }),
      }}
    />
  );
}
