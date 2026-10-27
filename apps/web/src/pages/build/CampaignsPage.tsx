import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';

export default function CampaignsPage() {
  return (
    <ArtifactListPage
      type="campaign"
      title="Campaigns"
      description="A thin grouping of broadcasts, journeys, templates, experiences, forms and segments under one goal and one shared UTM campaign. It reports; it does not send."
      emptyTitle="No campaigns yet"
      emptyText="Create one to group a newsletter series or a launch under a goal, then add the work that belongs to it. Agents can draft campaigns too."
      create={{
        label: 'New campaign',
        content: () => ({ goal: { kind: 'engagement', attributionDays: 7 }, members: [] }),
      }}
    />
  );
}
