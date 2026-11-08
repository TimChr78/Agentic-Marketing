import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { BlockEditor } from '../../features/blocks/BlockEditor';
import { BlockUsage } from '../../features/blocks/BlockUsage';

/** One reusable section: content, saved preview, where it is used, versions and activity (#526). */
export default function BlockPage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Blocks', to: '/content/templates?tab=blocks' }]}
      editor={(p) => <BlockEditor {...p} />}
      preview
      extraTabs={[{ key: 'usage', label: 'Used by', render: (a) => <BlockUsage artifactId={a.id} /> }]}
      detail={{
        kind: 'Reusable block',
        backTo: '/content/templates?tab=blocks',
        backLabel: 'Back to blocks',
        context: (_a, view) => (
          <section aria-label="Before publishing">
            <h2 className="mb-1 text-[13px] font-semibold text-fg">Before publishing</h2>
            <p className="text-[12px] leading-[18px] text-fg-2">
              {view.dirty
                ? 'Preview renders a saved version. Save this draft before you preview it or submit it for review.'
                : 'The preview renders this saved version with the block’s default parameters.'}
            </p>
            <p className="mt-2 text-[12px] leading-[18px] text-muted">
              Templates keep the block tag, so a later published block version is used the next time an e-mail is rendered. Open “Used by”
              to see which templates a change affects.
            </p>
          </section>
        ),
      }}
    />
  );
}
