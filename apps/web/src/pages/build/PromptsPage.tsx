import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';

export default function PromptsPage() {
  return (
    <ArtifactListPage
      type="prompt"
      title="AI prompts"
      description="Instructions for AI steps in journeys: choose a path, write content slots or label a text. Each one has test cases."
      emptyTitle="No prompts yet"
      emptyText="Create a prompt to use in an AI decision or AI content step. AI providers are set up under Settings → Providers."
      create={{
        label: 'New prompt',
        content: () => ({
          kind: 'decide',
          instructions: 'Choose the option that fits this person best, based on their traits and recent events.',
          model: 'default',
          options: [
            { key: 'engaged', description: 'Reads most issues' },
            { key: 'casual', description: 'Everyone else' },
          ],
        }),
      }}
    />
  );
}
