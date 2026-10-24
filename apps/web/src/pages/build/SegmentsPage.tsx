import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';

export default function SegmentsPage() {
  return (
    <ArtifactListPage
      type="segment"
      title="Segments"
      description="Groups of people by traits, events and consent. Broadcasts, journeys and experiences target them."
      emptyTitle="No segments yet"
      emptyText="Create a segment such as “Newsletter subscribers” (everyone who allows marketing e-mail), then use it in a broadcast."
      create={{ label: 'New segment', content: () => ({ description: '', condition: { consent: 'marketing_email' } }) }}
    />
  );
}
