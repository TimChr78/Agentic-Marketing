import { FileText } from 'lucide-react';
import { cx, StatusPill } from '../../ui';
import { type Asset, formatBytes } from './upload';

export function AssetThumb({ a, className }: { a: Asset; className?: string }) {
  return a.kind === 'image' ? (
    <img src={a.url} alt={a.altText} loading="lazy" className={cx('h-full w-full object-contain', className)} />
  ) : (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
      <FileText size={28} aria-hidden />
      <span className="text-[11px] uppercase">PDF</span>
    </span>
  );
}

/** Asset cards: thumbnail on a checkerboard-free neutral surface, name, size and usage. */
export function AssetGrid({ assets, onOpen, selectedId }: { assets: Asset[]; onOpen: (a: Asset) => void; selectedId?: string }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
      {assets.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => onOpen(a)}
            aria-pressed={selectedId ? selectedId === a.id : undefined}
            className={cx(
              'flex w-full flex-col overflow-hidden rounded-lg border bg-surface text-left transition-colors hover:border-control',
              selectedId === a.id ? 'border-accent ring-2 ring-accent/30' : 'border-line',
            )}
          >
            <span className="flex h-[120px] items-center justify-center bg-surface-2 p-2">
              <AssetThumb a={a} />
            </span>
            <span className="space-y-1 px-3 py-2">
              <span className="block truncate text-[13px] font-medium text-fg" title={a.name}>
                {a.name}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                {a.width && a.height ? `${a.width}×${a.height} · ` : ''}
                {formatBytes(a.byteSize)}
                {a.usageCount > 0 ? (
                  <StatusPill tone="neutral" dot={false}>
                    Used in {a.usageCount}
                  </StatusPill>
                ) : null}
                {a.kind === 'image' && !a.altText && (
                  <StatusPill tone="warn" dot={false}>
                    No alt text
                  </StatusPill>
                )}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
