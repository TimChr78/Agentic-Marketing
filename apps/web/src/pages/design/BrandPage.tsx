import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { usePageTab } from '../../app/useTab';
import { ArtifactDetailPage, type ArtifactDetailView } from '../../features/artifacts/ArtifactDetailPage';
import { type BrandContent, BrandEditor } from '../../features/brand/BrandEditor';
import { HostedPreview } from '../../features/brand/HostedPreview';
import { Alert, Button, DetailSkeleton, EmptyState, PageHeader, Tabs } from '../../ui';
import { pageWidth } from '../../ui/layout';
import HostedPagesPage from './HostedPagesPage';

/** Design → Brand (#37, #526): the workspace brand is one artifact, reviewed like any other change. */
export function BrandHome() {
  const { can, workspace } = useWorkspace();
  const list = useApi(() => api.call('artifacts.list', { type: 'brand', limit: 1 }), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brand = list.data?.artifacts[0];
  if (brand)
    return (
      <ArtifactDetailPage
        id={brand.id}
        crumbs={[]}
        preview={false}
        description="Name, logo, colours and wording of the pages subscribers see: confirm, expired link and unsubscribe. Changes go live after review."
        editor={(p) => <BrandEditor {...p} />}
        detail={{
          kind: 'Brand',
          context: (a, view) => <BrandContext artifact={a} view={view} />,
        }}
      />
    );
  return (
    <NoBrand
      loading={list.loading}
      error={list.error ?? error}
      busy={busy}
      canCreate={can('artifacts:write')}
      onRetry={list.reload}
      onCreate={async () => {
        setBusy(true);
        try {
          await api.call('artifacts.create', { type: 'brand', name: 'Brand', content: { siteName: workspace.name } });
          await list.reload();
        } catch (e) {
          setError(errText(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** The live preview context for the Brand detail. It previews the unsaved brand, never a saved one under that label. */
function BrandContext({ artifact, view }: { artifact: { version: { content: unknown } }; view: ArtifactDetailView }) {
  const content = (view.draft ?? artifact.version.content) as BrandContent;
  return (
    <section aria-label="Before publishing" className="space-y-3">
      <div>
        <h2 className="text-[13px] font-semibold text-fg">Before publishing</h2>
        <p className="mt-1 text-[12px] leading-[18px] text-fg-2">
          {view.dirty
            ? 'Live preview of your unsaved changes. Subscriber pages keep the published brand until you publish.'
            : 'Live preview of the saved brand. Subscriber pages use the published version.'}
        </p>
      </div>
      <HostedPreview brand={content} height={420} />
    </section>
  );
}

function NoBrand({
  loading,
  error,
  busy,
  canCreate,
  onCreate,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  busy: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onRetry: () => void;
}) {
  useCrumbs([{ label: 'Brand' }]);
  if (loading) return <DetailSkeleton label="Loading the brand" />;
  return (
    <div className={pageWidth('reading')}>
      <PageHeader title="Brand" description="Name, logo, colours and wording of the pages subscribers see." />
      {error && (
        <Alert tone="bad" onRetry={onRetry} className="mb-4">
          {error}
        </Alert>
      )}
      <EmptyState
        title="No brand yet"
        action={
          canCreate && (
            <Button variant="primary" icon={<Plus size={15} />} mutation loading={busy} onClick={onCreate}>
              Set up the brand
            </Button>
          )
        }
      >
        Until you set one up, confirm and unsubscribe pages use a plain neutral look.
      </EmptyState>
    </div>
  );
}

const BRAND_TABS = ['brand', 'subscriber-pages'] as const;
type BrandTab = (typeof BRAND_TABS)[number];

const BRAND_TAB_ITEMS: { key: BrandTab; label: string }[] = [
  { key: 'brand', label: 'Brand' },
  { key: 'subscriber-pages', label: 'Subscriber pages' },
];

/** Brand (#446, #526): the brand editor and the subscriber pages as outer tabs. */
export default function BrandPage() {
  const { active, invalid, select } = usePageTab({ keys: BRAND_TABS, fallback: 'brand' });
  useCrumbs([{ label: active === 'subscriber-pages' ? 'Subscriber pages' : 'Brand' }]);

  return (
    <div className={pageWidth('default')}>
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={BRAND_TAB_ITEMS} value={active} onChange={select} label="Brand">
        {active === 'subscriber-pages' ? <HostedPagesPage /> : <BrandHome />}
      </Tabs>
    </div>
  );
}
