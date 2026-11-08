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
