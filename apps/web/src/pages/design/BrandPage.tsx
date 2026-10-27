import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { BrandEditor } from '../../features/brand/BrandEditor';
import { Alert, Button, EmptyState, LoadingBlock, PageHeader } from '../../ui';
import { pageWidth } from '../../ui/layout';

/** Design → Brand (#37): the workspace brand is one artifact, reviewed like any other change. */
export default function BrandPage() {
  const { can, workspace } = useWorkspace();
  const list = useApi(() => api.call('artifacts.list', { type: 'brand', limit: 1 }), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brand = list.data?.artifacts[0];
  if (brand) return <ArtifactDetailPage id={brand.id} crumbs={[]} wide preview={false} description="Name, logo, colours and wording of the pages subscribers see: confirm, expired link and unsubscribe. Changes go live after review." editor={(p) => <BrandEditor {...p} />} />;
  return <NoBrand loading={list.loading} error={list.error ?? error} busy={busy} canCreate={can('artifacts:write')} onRetry={list.reload} onCreate={async () => {
    setBusy(true);
    try {
      await api.call('artifacts.create', { type: 'brand', name: 'Brand', content: { siteName: workspace.name } });
      await list.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }} />;
}

function NoBrand({ loading, error, busy, canCreate, onCreate, onRetry }: { loading: boolean; error: string | null; busy: boolean; canCreate: boolean; onCreate: () => void; onRetry: () => void }) {
  useCrumbs([{ label: 'Brand' }]);
  if (loading) return <LoadingBlock lines={6} />;
  return (
    <div className={pageWidth('reading')}>
      <PageHeader title="Brand" description="Name, logo, colours and wording of the pages subscribers see." />
      {error && <Alert tone="bad" onRetry={onRetry} className="mb-4">{error}</Alert>}
      <EmptyState title="No brand yet" action={canCreate && <Button variant="primary" icon={<Plus size={15} />} loading={busy} onClick={onCreate}>Set up the brand</Button>}>
        Until you set one up, confirm and unsubscribe pages use a plain neutral look.
      </EmptyState>
    </div>
  );
}
