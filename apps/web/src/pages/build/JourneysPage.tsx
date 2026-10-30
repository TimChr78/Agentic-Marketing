import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';

export default function JourneysPage() {
  return (
    <ArtifactListPage
      type="journey"
      title="Journeys"
      description="Automated paths: a trigger, then messages, waits, branches and AI steps. Build them on a canvas or let an agent draft them; people approve."
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
