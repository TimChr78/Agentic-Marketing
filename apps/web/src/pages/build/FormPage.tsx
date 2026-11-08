import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { FormEditor } from '../../features/artifacts/FormEditor';
import { audienceActions, audienceMetadata, ConsequenceInset, FormPreviewAside } from '../../features/phase27/audience/detail';

export default function FormPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Forms', to: '/audience/forms' }]}
      wide
      editor={(p) => <FormEditor {...p} />}
      detail={{
        kind: 'Form',
        notFoundTitle: 'Form not found',
        errorTitle: 'Couldn’t open this form',
        backTo: '/audience/forms',
        backLabel: 'Back to forms',
        restrictedTitle: 'Forms are restricted',
        restrictedBody: 'Reading forms needs permission to read artifacts. Ask a workspace admin to give you access.',
        metadata: audienceMetadata,
        actions: audienceActions,
        consequence: (a, view) => (
          <ConsequenceInset>
            <p>
              Content changes stay in a draft until they are published. The live form and its confirmation pages keep working until then.
            </p>
            {a.publishedVersion === null && <p className="mt-1">This form has not been published yet, so the site cannot submit to it.</p>}
            {view.dirty && <p className="mt-1">Unsaved changes are not part of the published version.</p>}
          </ConsequenceInset>
        ),
        context: (a, view) => <FormPreviewAside artifact={a} view={view} />,
      }}
    />
  );
}
