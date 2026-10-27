import { Search, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errText } from '../../app/api';
import { artifactPath, typeLabel } from '../../app/artifactRoutes';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { AssetGrid, AssetThumb } from '../../features/assets/AssetGrid';
import { ACCEPT, type Asset, formatBytes, uploadFile } from '../../features/assets/upload';
import { Alert, Button, CodeView, cx, Drawer, EmptyState, Field, formatDateTime, Input, LoadingBlock, Meta, PageHeader, Select, Skeleton, StatusPill, Textarea, useConfirm, useToast } from '../../ui';

/** Asset library (#35): upload, search, alt text, where each asset is used, safe delete. */
export default function AssetsPage() {
  useCrumbs([{ label: 'Assets' }]);
  const { can } = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | 'image' | 'file'>('');
  const list = useApi(() => api.call('assets.list', { query: q || undefined, kind: kind || undefined, limit: 200 }), [q, kind]);
  const [open, setOpen] = useState<Asset | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canWrite = can('artifacts:write');

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setErrors([]);
    setUploading(files.map((f) => f.name));
    const failed: string[] = [];
    let ok = 0;
    for (const f of files) {
      try {
        await uploadFile(f);
        ok++;
      } catch (e) {
        failed.push(`${f.name}: ${errText(e)}`);
      }
      setUploading((u) => u.filter((n) => n !== f.name));
    }
    setErrors(failed);
    if (ok) toast.success(ok === 1 ? 'Uploaded 1 file. Add alt text so screen readers can describe it.' : `Uploaded ${ok} files.`);
    void list.reload();
  };

  const assets = list.data?.assets ?? [];
  return (
    <div
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
      className={cx('min-h-[60vh] rounded-xl', dragging && 'outline-2 outline-offset-8 outline-accent outline-dashed')}
    >
      <PageHeader
        title="Assets"
        description="Images and PDFs for e-mails and hosted pages, served from your public links address with long caching. PNG, JPEG, GIF, WebP, SVG or PDF; SVG uploads are sanitised and get a PNG version for e-mail."
        actions={
          canWrite && (
            <>
              <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => (void upload([...(e.target.files ?? [])]), (e.target.value = ''))} />
              <Button variant="primary" icon={<Upload size={15} />} onClick={() => input.current?.click()} loading={uploading.length > 0}>
                Upload
              </Button>
            </>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-[320px]">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
          <Input aria-label="Search assets" placeholder="Search by name or alt text" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-auto">
          <option value="">Images and PDFs</option>
          <option value="image">Images</option>
          <option value="file">PDFs</option>
        </Select>
        {canWrite && <span className="ml-auto hidden text-[12px] text-muted md:block">Drop files anywhere on this page to upload.</span>}
      </div>
      {errors.length > 0 && (
        <Alert tone="bad" title="Some files were not uploaded" className="mb-4">
          <ul className="list-disc pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {uploading.length > 0 && (
        <div className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3" role="status" aria-label={`Uploading ${uploading.length} files`}>
          {uploading.map((n) => (
            <div key={n} className="rounded-lg border border-line bg-surface p-2">
              <Skeleton className="h-[104px] w-full" />
              <p className="mt-2 truncate text-[12px] text-muted">{n}</p>
            </div>
          ))}
        </div>
      )}
      {list.loading ? (
        <LoadingBlock lines={6} />
      ) : list.error ? (
        <Alert tone="bad" title="Couldn't load assets" onRetry={list.reload}>
          {list.error}
        </Alert>
      ) : assets.length ? (
        <AssetGrid assets={assets} onOpen={setOpen} />
      ) : (
        <div className="rounded-lg border border-dashed border-line-strong">
          <EmptyState
            title={q || kind ? 'Nothing matches' : 'No assets yet'}
            action={!q && !kind && canWrite && <Button variant="primary" icon={<Upload size={15} />} onClick={() => input.current?.click()}>Upload</Button>}
          >
            {q || kind ? 'Clear the search or choose another kind.' : 'Upload your logo and images for e-mails here, or drop files on this page. Then pick them in the template editor and the brand settings.'}
          </EmptyState>
        </div>
      )}
      {open && (
        <AssetDrawer
          id={open.id}
          onClose={() => setOpen(null)}
          onChanged={() => void list.reload()}
        />
      )}
    </div>
  );
}

function AssetDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const a = useApi(() => api.call('assets.get', { id }), [id]);
  const [name, setName] = useState<string | null>(null);
  const [alt, setAlt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asset = a.data;
  const canWrite = can('artifacts:write');
  const dirty = !!asset && ((name !== null && name !== asset.name) || (alt !== null && alt !== asset.altText));

  const save = async () => {
    if (!asset) return;
    setBusy(true);
    setError(null);
    try {
      await api.call('assets.update', { id: asset.id, ...(name !== null && name !== asset.name ? { name } : {}), ...(alt !== null && alt !== asset.altText ? { altText: alt } : {}) });
      toast.success('Saved.');
      setName(null);
      setAlt(null);
      await a.reload();
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!asset) return;
    const used = asset.usage.length;
    const ok = await confirm({
      title: `Delete “${asset.name}”?`,
      body: used ? (
        <>
          <p className="text-bad">It is used in {used === 1 ? '1 item' : `${used} items`}. Their images break once it is deleted:</p>
          <ul className="mt-2 list-disc pl-5">
            {asset.usage.map((u) => (
              <li key={u.artifactId}>
                {u.artifactName} <span className="text-muted">({typeLabel(u.artifactType)}{u.versions.includes('published') ? ', live' : ''})</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        'Its public URL stops working. This cannot be undone.'
      ),
      confirmLabel: used ? 'Delete anyway' : 'Delete asset',
      destructive: true,
      typeToConfirm: used ? asset.name : undefined,
    });
    if (!ok) return;
    try {
      await api.call('assets.delete', { id: asset.id, force: used > 0 });
      toast.success(`Deleted “${asset.name}”.`);
      onChanged();
      onClose();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={asset?.name ?? 'Asset'}
      meta={asset && `${asset.contentType} · ${formatBytes(asset.byteSize)}${asset.width ? ` · ${asset.width}×${asset.height} px` : ''}`}
      footer={
        asset &&
        canWrite && (
          <>
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
            <Button variant="primary" className="ml-auto" disabled={!dirty} loading={busy} onClick={save}>
              Save changes
            </Button>
          </>
        )
      }
    >
      {a.loading ? (
        <LoadingBlock lines={8} />
      ) : a.error ? (
        <div className="p-5">
          <Alert tone="bad" onRetry={a.reload}>{a.error}</Alert>
        </div>
      ) : asset ? (
        <div className="space-y-5 p-5">
          <div className="flex h-[260px] items-center justify-center rounded-lg border border-line bg-surface-2 p-3">
            <AssetThumb a={asset} />
          </div>
          <CodeView value={asset.url} label="Public URL" />
          <Field label="Name" hint="For finding it here; not shown to recipients.">
            <Input value={name ?? asset.name} onChange={(e) => setName(e.target.value)} readOnly={!canWrite} maxLength={120} />
          </Field>
          {asset.kind === 'image' && (
            <Field label="Alt text" hint="Read aloud by screen readers and shown when images are blocked. Describe what the image shows; leave empty only for decoration.">
              <Textarea rows={2} value={alt ?? asset.altText} onChange={(e) => setAlt(e.target.value)} readOnly={!canWrite} maxLength={500} />
            </Field>
          )}
          {error && <Alert tone="bad">{error}</Alert>}
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">Used in</h3>
            {asset.usage.length ? (
              <ul className="space-y-1.5 text-[13px]">
                {asset.usage.map((u) => (
                  <li key={u.artifactId} className="flex flex-wrap items-center gap-2">
                    <Link to={artifactPath(u.artifactType, u.artifactId)} className="font-medium text-accent hover:underline">
                      {u.artifactName}
                    </Link>
                    <span className="text-muted">{typeLabel(u.artifactType)}</span>
                    {u.versions.includes('published') && <StatusPill tone="good">Live</StatusPill>}
                    {u.versions.includes('latest') && !u.versions.includes('published') && <StatusPill>Draft</StatusPill>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Not used in any template, form or brand yet.</p>
            )}
          </section>
          <Meta items={[['Uploaded', formatDateTime(asset.createdAt)], ['File name', asset.fileName]]} />
        </div>
      ) : null}
      {confirmDialog}
    </Drawer>
  );
}
