import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { SegmentEditor } from '../../features/artifacts/SegmentEditor';
import { audienceActions, audienceMetadata, ConsequenceInset, SegmentContextAside } from '../../features/phase27/audience/detail';

export default function SegmentPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Segments', to: '/audience/segments' }]}
      wide
      editor={(p) => <SegmentEditor {...p} />}
      detail={{
        kind: 'Segment',
        notFoundTitle: 'Segment not found',
        errorTitle: 'Couldn’t open this segment',
        backTo: '/audience/segments',
        backLabel: 'Back to segments',
        restrictedTitle: 'Segments are restricted',
        restrictedBody: 'Reading segments needs permission to read artifacts. Ask a workspace admin to give you access.',
        metadata: audienceMetadata,
        actions: audienceActions,
        consequence: (a, view) => {
          const mode = (a.version.content as { mode?: string } | null)?.mode ?? 'dynamic';
          return (
            <ConsequenceInset>
              <p>
                {mode === 'dynamic'
                  ? 'The rules decide who is in the audience whenever it is used. Saving keeps a draft; publishing makes the new rules live.'
                  : 'Changing members is immediate data, not a new version. The saved description and rules keep their own versions.'}
              </p>
              {view.dirty && <p className="mt-1">Unsaved changes are not part of the published version.</p>}
            </ConsequenceInset>
          );
        },
        context: (a, view) => <SegmentContextAside artifact={a} view={view} />,
      }}
    />
  );
}
