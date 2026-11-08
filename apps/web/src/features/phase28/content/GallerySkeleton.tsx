import { cx, Skeleton, SkeletonRegion } from '../../../ui';

/**
 * A thumbnail gallery read (Phase 28, #559): the same auto-fill column track, gap and tile height
 * as the ready grid, so replacing the placeholder with real tiles does not move the page. The
 * containing region announces the busy state once with the object-specific label; the tiles are
 * static tonal shapes, never a shimmer.
 */
export function GallerySkeleton({
  label,
  minWidth = 220,
  tileHeight = 170,
  tiles = 6,
  className,
}: {
  /** Object-specific status, e.g. "Loading templates". */
  label: string;
  /** The ready grid's minimum tile width. */
  minWidth?: number;
  /** The ready tile's height. */
  tileHeight?: number;
  tiles?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} geometry="list" className={cx('p-3 md:p-4', className)}>
      <ul className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))` }}>
        {Array.from({ length: tiles }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder tiles have no identity and never reorder
          <li key={i}>
            <Skeleton shape="card" className="w-full" height={tileHeight} />
          </li>
        ))}
      </ul>
    </SkeletonRegion>
  );
}

/**
 * The phone half of a content list read (#555 review). Below 768 px the ready list is the compact
 * summary list — a 72 px minimum row per object — not the desktop gallery's 170 px tiles, so the
 * placeholder must reserve that row geometry or the page jumps when the read resolves. The caller
 * shows this below `md` and `GallerySkeleton` above it.
 */
export function PhoneListSkeleton({
  label,
  rows = 5,
  rowHeight = 72,
  className,
}: {
  label: string;
  rows?: number;
  rowHeight?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} geometry="list" className={cx('md:hidden', className)}>
      <ul className="divide-y divide-line" data-skeleton-phone-list="">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder rows have no identity and never reorder
          <li key={i} className="px-4 py-3" style={{ minHeight: rowHeight }}>
            <div className="flex items-start justify-between gap-3">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="mt-1 flex items-center gap-x-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-12" />
            </div>
          </li>
        ))}
      </ul>
    </SkeletonRegion>
  );
}
