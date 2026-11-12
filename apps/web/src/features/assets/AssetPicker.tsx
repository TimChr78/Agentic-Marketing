import { Search, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errText } from '../../app/api';
import { useKeyedApi } from '../../app/useApi';
import { Alert, Button, EmptyState, Input, Modal } from '../../ui';
import { GallerySkeleton } from '../phase28/content/GallerySkeleton';
import { AssetGrid } from './AssetGrid';
import { type Asset, uploadFile } from './upload';

/** Choose an image from the asset library, or upload one (#35). */
export function AssetPicker({
  onPick,
  onClose,
  kind = 'image',
  title = 'Choose an image',
}: {
  onPick: (a: Asset) => void;
  onClose: () => void;
  kind?: 'image' | 'file';
  title?: string;
}) {
  const [q, setQ] = useState('');
  const filterKey = `${kind}|${q}`;
  const list = useKeyedApi(filterKey, () => api.call('assets.list', { kind, query: q || undefined, limit: 100 }));
  const [selected, setSelected] = useState<Asset | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={title}
      footer={
        <>
          <input
            ref={file}
            type="file"
            hidden
            accept={kind === 'image' ? 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml' : 'application/pdf'}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setUploading(true);
              setError(null);
              try {
                const a = await uploadFile(f);
                await list.reload();
                setSelected(a);
              } catch (err) {
                setError(errText(err));
              } finally {
                setUploading(false);
              }
            }}
          />
          <Button icon={<Upload size={14} />} loading={uploading} onClick={() => file.current?.click()} className="mr-auto">
            Upload
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!selected} onClick={() => selected && onPick(selected)}>
            Use {selected ? `“${selected.name}”` : 'image'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            aria-label="Search assets"
            placeholder="Search by name or alt text"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-autofocus
          />
        </div>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="max-h-[52vh] overflow-y-auto p-1">
          {list.loading ? (
            <GallerySkeleton
              label={kind === 'image' ? 'Loading images' : 'Loading files'}
              minWidth={176}
              tileHeight={190}
              tiles={4}
              className="p-0"
            />
          ) : list.error ? (
            <Alert tone="bad" onRetry={list.reload}>
              {list.error}
            </Alert>
          ) : list.data!.assets.length ? (
            <AssetGrid assets={list.data!.assets} onOpen={setSelected} selectedId={selected?.id} />
          ) : (
            <EmptyState compact title={q ? 'Nothing matches' : kind === 'image' ? 'No images yet' : 'No files yet'}>
              {q
                ? 'Try another search.'
                : kind === 'image'
                  ? 'Upload a PNG, JPEG, GIF, WebP or SVG to use it here.'
                  : 'Upload a PDF to use it here.'}
            </EmptyState>
          )}
        </div>
      </div>
    </Modal>
  );
}
