import { Search, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errText } from '../../app/api';
import { artifactPath, typeLabel } from '../../app/artifactRoutes';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useSession } from '../../app/session';
import { useKeyedApi } from '../../app/useApi';
import { AssetGrid, AssetThumb } from '../../features/assets/AssetGrid';
import { ACCEPT, type Asset, formatBytes, uploadFile } from '../../features/assets/upload';
import { GallerySkeleton, PhoneListSkeleton } from '../../features/phase28/content/GallerySkeleton';
import {
  Alert,
  Button,
  CodeView,
  cx,
  Drawer,
  Field,
  formatDateTime,
  Input,
  LoadingBlock,
  Meta,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  useConfirm,
  useToast,
} from '../../ui';
import { ListPage, type PageReadState } from '../../ui/ListPage';
import { pageWidth } from '../../ui/layout';

/** Asset library (#35, #526): upload, search, alt text, where each asset is used, safe delete. */
export default function AssetsPage() {
  useCrumbs([{ label: 'Assets' }]);
  const { can } = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [committedQ, setCommittedQ] = useState('');
  const [kind, setKind] = useState<'' | 'image' | 'file'>('');
  // The list reads once per committed filter, not once per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setCommittedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const filterKey = `${committedQ}|${kind}`;
  const list = useKeyedApi(filterKey, () =>
    api.call('assets.list', { query: committedQ || undefined, kind: kind || undefined, limit: 200 }),
  );
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
  const filtered = !!q || !!kind;
  const state: PageReadState = list.loading ? 'loading' : list.error ? 'error' : assets.length === 0 ? 'empty' : 'ready';
  const countLabel = assets.length ? `${assets.length} shown · up to 200` : undefined;

  const openFile = () => input.current?.click();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is a mouse enhancement; uploading also works through the Upload button
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
      className={cx(
        pageWidth('default'),
        'min-h-[60vh] rounded-xl',
        dragging && 'outline-2 outline-offset-8 outline-accent outline-dashed',
      )}
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        onChange={(e) => {
          void upload([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
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
        <div
          className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3"
          role="status"
          aria-label={`Uploading ${uploading.length} files`}
        >
          {uploading.map((n) => (
            <div key={n} className="rounded-lg border border-line bg-surface p-2">
              <Skeleton className="h-[104px] w-full" />
              <p className="mt-2 truncate text-[12px] text-muted">{n}</p>
            </div>
          ))}
        </div>
      )}
      <ListPage
        title="Assets"
        description="Images and PDFs for e-mails and hosted pages, served from your public links address with long caching. PNG, JPEG, GIF, WebP, SVG or PDF; SVG uploads are sanitised and get a PNG version for e-mail."
        primaryAction={
          canWrite && (
            <Button variant="primary" icon={<Upload size={15} />} mutation onClick={openFile} loading={uploading.length > 0}>
              Upload
            </Button>
          )
        }
        filters={
          <>
            <div className="relative w-full max-w-[280px]">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                compact
                aria-label="Search assets"
                placeholder="Search by name or alt text"
                className="pl-8"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select compact aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-auto">
              <option value="">Images and PDFs</option>
              <option value="image">Images</option>
              <option value="file">PDFs</option>
            </Select>
            {canWrite && <span className="hidden text-[12px] text-muted md:block">Drop files anywhere on this page to upload.</span>}
          </>
        }
        countLabel={countLabel}
        state={state}
        notice={
          state === 'error'
            ? {
                title: 'Couldn’t load assets',
                body: list.error,
                action: <Button onClick={() => void list.reload()}>Retry</Button>,
              }
            : state === 'empty'
              ? filtered
                ? {
                    title: 'Nothing matches',
                    body: 'Clear the search or choose another kind.',
                    action: (
                      <Button
                        onClick={() => {
                          setQ('');
                          setKind('');
                        }}
                      >
                        Clear filters
                      </Button>
                    ),
                  }
                : {
                    title: 'No assets yet',
                    body: 'Upload your logo and images for e-mails here, or drop files on this page. Then pick them in the template editor and the brand settings.',
                    action: canWrite ? (
                      <Button variant="primary" icon={<Upload size={15} />} mutation onClick={openFile}>
                        Upload
                      </Button>
                    ) : undefined,
                  }
              : undefined
        }
        loadingContent={
          <>
            <PhoneListSkeleton label="Loading assets" />
            <div className="hidden md:block">
              <GallerySkeleton label="Loading assets" minWidth={176} tileHeight={190} />
            </div>
          </>
        }
        desktopTable={<AssetGrid assets={assets} onOpen={setOpen} />}
        mobileList={<AssetPhoneList assets={assets} onOpen={setOpen} />}
      />
      {open && <AssetDrawer id={open.id} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}

function AssetPhoneList({ assets, onOpen }: { assets: Asset[]; onOpen: (a: Asset) => void }) {
  return (
    <ul aria-label="Assets list" className="divide-y divide-line">
      {assets.map((a) => (
        <li key={a.id}>
          <button type="button" onClick={() => onOpen(a)} className="flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left">
            <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-surface-2">
              <AssetThumb a={a} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-fg">{a.name}</span>
              <span className="mt-0.5 block text-[12px] leading-[18px] text-muted">
                {a.kind === 'image' ? 'Image' : 'PDF'}
                {a.width && a.height ? ` · ${a.width}×${a.height}` : ''} · {formatBytes(a.byteSize)}
                {a.usageCount > 0 ? ` · Used in ${a.usageCount}` : ''}
              </span>
            </span>
            {a.kind === 'image' && !a.altText && (
              <StatusPill tone="warn" dot={false}>
                No alt text
              </StatusPill>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function AssetDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const a = useKeyedApi(id, () => api.call('assets.get', { id }));
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
      await api.call('assets.update', {
        id: asset.id,
        ...(name !== null && name !== asset.name ? { name } : {}),
        ...(alt !== null && alt !== asset.altText ? { altText: alt } : {}),
      });
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
                {u.artifactName}{' '}
                <span className="text-muted">
                  ({typeLabel(u.artifactType)}
                  {u.versions.includes('published') ? ', live' : ''})
                </span>
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
            <Button variant="danger" mutation onClick={remove}>
              Delete
            </Button>
            <Button variant="primary" className="ml-auto" mutation disabled={!dirty} loading={busy} onClick={save}>
              Save changes
            </Button>
          </>
        )
      }
    >
      {a.loading ? (
        <LoadingBlock geometry="detail" label="Loading this asset" />
      ) : a.error ? (
        <div className="p-5">
          <Alert tone="bad" title="This asset is unavailable" onRetry={a.reload}>
            {a.error} Choose another asset or upload it again.
          </Alert>
        </div>
      ) : asset ? (
        <div className="space-y-5 p-5">
          <div className="flex h-[260px] items-center justify-center rounded-lg border border-line bg-surface-2 p-3">
            <AssetThumb a={asset} />
          </div>
          <CodeView value={asset.url} label="Public URL" />
          {asset.rendition && (
            <>
              <CodeView value={asset.rendition.url} label="PNG version for e-mail" />
              <p className="-mt-2 text-[12px] leading-[18px] text-muted">
                Use the generated PNG version in e-mail; the sanitised SVG remains available for hosted pages.
              </p>
            </>
          )}
          {asset.sanitized.length > 0 && (
            <Alert tone="info" title="This SVG was sanitised">
              Removed: {asset.sanitized.join(', ')}. The original file is not served.
            </Alert>
          )}
          <Field label="Name" hint="For finding it here; not shown to recipients.">
            <Input value={name ?? asset.name} onChange={(e) => setName(e.target.value)} readOnly={!canWrite} maxLength={120} />
          </Field>
          {asset.kind === 'image' && (
            <Field
              label="Alt text"
              hint="Read aloud by screen readers and shown when images are blocked. Describe what the image shows; leave empty only for decoration."
            >
              <Textarea
                rows={2}
                value={alt ?? asset.altText}
                onChange={(e) => setAlt(e.target.value)}
                readOnly={!canWrite}
                maxLength={500}
              />
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
          <Meta
            items={[
              ['Uploaded', formatDateTime(asset.createdAt)],
              ['File name', asset.fileName],
            ]}
          />
        </div>
      ) : null}
      {confirmDialog}
    </Drawer>
  );
}
