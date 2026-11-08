import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { ExperienceResults } from '../../features/artifacts/ExperienceResults';
import { audienceActions, audienceMetadata, ConsequenceInset, ExperienceContextAside } from '../../features/phase27/audience/detail';

export default function ExperiencePage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Experiences', to: '/marketing/experiences' }]}
      extraTabs={[{ key: 'results', label: 'Results', render: (a) => <ExperienceResults artifact={a} /> }]}
      detail={{
        kind: 'Web experience',
        notFoundTitle: 'Experience not found',
        errorTitle: 'Couldn’t open this experience',
        backTo: '/marketing/experiences',
        backLabel: 'Back to experiences',
        restrictedTitle: 'Experiences are restricted',
        restrictedBody: 'Reading experiences needs permission to read artifacts. Ask a workspace admin to give you access.',
        metadata: audienceMetadata,
        actions: audienceActions,
        consequence: (_a, view) => (
          <ConsequenceInset>
            <p>
              Visitors are split across variants by their relative weights; the holdout sees nothing. Results count real exposures and
              conversions, never previews.
            </p>
            {view.dirty && <p className="mt-1">Unsaved changes are not part of the published version.</p>}
          </ConsequenceInset>
        ),
        context: (a, view) => <ExperienceContextAside artifact={a} view={view} />,
      }}
    />
  );
}
