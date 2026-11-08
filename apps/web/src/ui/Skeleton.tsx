import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { cx } from './cx';

// Phase 28 (#555) reserved loading geometry. A skeleton is never a spinner or a shimmer: it is a
// static tonal shape that occupies the place the real content will use, so the page does not move
// when the read resolves. The caller owns the read; this file never fetches.
//
// Timing: the slot is reserved immediately and the tonal shapes are revealed after 150 ms. A read
// that answers sooner keeps the slot quiet and never delays the content.
export const SKELETON_DELAY_MS = 150;

export type SkeletonShape = 'text' | 'row' | 'card' | 'chart' | 'kpi' | 'editor';

/** A whole region, using the existing DESIGN geometry of the template it stands in for. */
export type SkeletonGeometry = 'text' | 'list' | 'detail' | 'chart' | 'kpi' | 'settings' | 'auth';

/** The reserved dimensions, exported so tests and area tasks use the same numbers. */
export const SKELETON_GEOMETRY = {
  text: { height: 14, lineHeight: 22 },
  row: { height: 48 },
  card: { minHeight: 88, padding: 16 },
  chart: { plot: 200, plotDesktop: 240, heading: 24, subtitle: 18, toggle: 32 },
  kpi: { minHeight: 204, padding: 20, value: 40 },
  editor: { mobile: 420, desktop: 560 },
  list: { header: 36, rows: 5, row: 48, card: 88 },
  detail: { title: 32, meta: 22, consequence: 64, panel: 240 },
  settings: { label: 20, control: 32, hint: 18 },
  auth: { card: 120 },
} as const;

const SHAPE_CLASS: Record<SkeletonShape, string> = {
  text: 'h-3.5 w-3/5',
  row: 'h-12 w-full',
  card: 'min-h-[88px] w-full rounded-lg',
  chart: 'h-[200px] w-full rounded-lg md:h-[240px]',
  kpi: 'min-h-[204px] w-full rounded-lg',
  editor: 'h-[420px] w-full rounded-lg md:h-[560px]',
};

export interface SkeletonProps {
  /** The final geometry this placeholder stands in for. Defaults to one text line. */
  shape?: SkeletonShape;
  /** Text lines; only `text` and `card` use more than one. */
  lines?: number;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

/**
 * One static tonal shape. It is always `aria-hidden`: the containing region announces the busy
 * state once, with the object-specific label.
 *
 * Area tasks should prefer a whole-region component (`ListSkeleton`, `DetailSkeleton`,
 * `ChartSkeleton`, `KpiSkeleton`, `EditorSkeleton`) or pass `geometry` to `LoadingBlock`; use this
 * primitive only when composing an existing template's exact slots.
 */
export function Skeleton({ shape = 'text', lines = 1, width, height, className, style }: SkeletonProps) {
  const base = cx('am-skeleton block', SHAPE_CLASS[shape], className);
  const own: CSSProperties = { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...style };
  const sized = width !== undefined || height !== undefined || style !== undefined ? own : undefined;

  if (shape === 'text' && lines > 1)
    return (
      <span className="block space-y-2" aria-hidden data-skeleton-shape="text" data-lines={lines}>
        {Array.from({ length: lines }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder lines have no identity and never reorder
            key={i}
            className={cx('am-skeleton block h-3.5', i % 3 === 2 ? 'w-2/5' : i % 2 ? 'w-4/5' : 'w-3/5', className)}
            style={sized}
          />
        ))}
      </span>
    );

  return <span className={base} style={sized} aria-hidden data-skeleton-shape={shape} data-lines={shape === 'text' ? lines : undefined} />;
}

/**
 * The labelled busy region. It reserves its geometry immediately; children become visible after
 * `delay` so a fast read never flashes a placeholder. `aria-busy` belongs here, never on every bar.
 */
export function SkeletonRegion({
  label,
  geometry,
  busy = true,
  delay = SKELETON_DELAY_MS,
  minHeight,
  className,
  children,
}: {
  label: string;
  geometry?: SkeletonGeometry;
  busy?: boolean;
  delay?: number;
  /** Override the reserved height when the template's own slot is known. */
  minHeight?: number | string;
  className?: string;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  return (
    <div
      role="status"
      aria-label={label}
      aria-busy={busy || undefined}
      data-skeleton-region=""
      data-geometry={geometry}
      data-skeleton-visible={visible ? 'true' : 'false'}
      style={minHeight === undefined ? undefined : { minHeight }}
      className={cx('min-w-0', className)}
    >
      <div aria-hidden className={visible ? undefined : 'invisible'}>
        {children}
      </div>
    </div>
  );
}

const WIDTHS = ['w-3/5', 'w-4/5', 'w-2/5', 'w-3/5', 'w-4/5', 'w-2/5'];

/** Generic text lines in place of a read; the legacy adapter used by existing call sites. */
export function LoadingBlock({
  lines = 4,
  label = 'Loading',
  geometry,
  delay = SKELETON_DELAY_MS,
  className,
}: {
  lines?: number;
  label?: string;
  geometry?: SkeletonGeometry;
  delay?: number;
  className?: string;
}) {
  if (geometry === 'list') return <ListSkeleton label={label} delay={delay} className={className} />;
  if (geometry === 'detail') return <DetailSkeleton label={label} delay={delay} className={className} />;
  if (geometry === 'chart') return <ChartSkeleton label={label} delay={delay} className={className} />;
  if (geometry === 'kpi') return <KpiSkeleton label={label} delay={delay} className={className} />;

  return (
    <SkeletonRegion label={label} geometry={geometry} delay={delay} className={cx('space-y-2.5 p-4', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder lines have no identity and never reorder
          key={i}
          shape="text"
          className={WIDTHS[i % WIDTHS.length]}
        />
      ))}
    </SkeletonRegion>
  );
}

/**
 * A list read: the real table header plus five 48 px rows at 768 px and wider, and five 88 px
 * summary cards below it. Both branches match the ready template's row heights.
 */
export function ListSkeleton({
  label = 'Loading list',
  rows = SKELETON_GEOMETRY.list.rows,
  columns = 4,
  delay = SKELETON_DELAY_MS,
  className,
}: {
  label?: string;
  rows?: number;
  columns?: number;
  delay?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} geometry="list" delay={delay} className={className}>
      <div className="hidden md:block" data-skeleton-list="table">
        <div className="flex h-9 items-center gap-4 border-b border-line bg-surface-2 px-4">
          {Array.from({ length: columns }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder cells are positional columns of a generated row
            <Skeleton key={c} className={cx('h-3', c === 0 ? 'w-1/4' : 'w-1/6')} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder rows have no identity and never reorder
          <div key={i} className="flex h-12 items-center gap-4 border-b border-line px-4 last:border-0">
            {Array.from({ length: columns }, (_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder cells are positional columns of a generated row
              <Skeleton key={c} className={cx('h-3.5', c === 0 ? 'w-1/3' : 'w-1/6')} />
            ))}
          </div>
        ))}
      </div>
      <div className="md:hidden" data-skeleton-list="cards">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder cards have no identity and never reorder
          <div key={i} className="flex min-h-[88px] flex-col justify-center gap-2 border-b border-line p-4 last:border-0">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** A detail read: the real header (title, metadata line, consequence inset) and panel body. */
export function DetailSkeleton({
  label = 'Loading details',
  delay = SKELETON_DELAY_MS,
  className,
}: {
  label?: string;
  delay?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} geometry="detail" delay={delay} className={cx('space-y-4', className)}>
      <div className="space-y-3" data-skeleton-detail="header">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-16 w-full max-w-[800px] rounded-lg" />
      </div>
      <div className="space-y-3 rounded-lg border border-line bg-surface p-4 md:p-5" data-skeleton-detail="panel">
        <Skeleton className="h-3 w-1/4" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </SkeletonRegion>
  );
}

/** A chart read: heading and subtitle, the 200/240 px plot, and the data-table toggle. */
export function ChartSkeleton({
  label = 'Loading chart',
  delay = SKELETON_DELAY_MS,
  className,
}: {
  label?: string;
  delay?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} geometry="chart" delay={delay} className={cx('space-y-3', className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton shape="chart" />
      <Skeleton className="h-8 w-32 rounded-md" />
    </SkeletonRegion>
  );
}

/** A KPI tile: 204 px minimum height with the value and its qualifying lines. */
export function KpiSkeleton({
  label = 'Loading metric',
  delay = SKELETON_DELAY_MS,
  className,
}: {
  label?: string;
  delay?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} geometry="kpi" delay={delay} minHeight={SKELETON_GEOMETRY.kpi.minHeight} className={className}>
      <div className="space-y-3 p-5">
        <Skeleton className="h-3 w-2/5" />
        <Skeleton shape="text" className="w-24" height={SKELETON_GEOMETRY.kpi.value} />
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </SkeletonRegion>
  );
}

/** The visual e-mail editor's outer frame: 420 px below 768 px, 560 px above it. */
export function EditorSkeleton({
  label = 'Loading the editor',
  delay = SKELETON_DELAY_MS,
  className,
}: {
  label?: string;
  delay?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} geometry="settings" delay={delay} className={className}>
      <Skeleton shape="editor" />
    </SkeletonRegion>
  );
}

/** The signed-out frame: the same 380 px column and field heights the auth screens use. */
export function AuthSkeleton({ label = 'Loading the sign-in screen', delay = SKELETON_DELAY_MS }: { label?: string; delay?: number }) {
  return (
    <div className="px-4">
      <div className="h-14" />
      <div className="mx-auto w-full max-w-[380px] pt-[8vh]">
        <SkeletonRegion label={label} geometry="auth" delay={delay} className="mx-auto w-full max-w-[380px]">
          <div className="space-y-6">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8 rounded-md" />
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-3 w-64" />
            </div>
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        </SkeletonRegion>
      </div>
    </div>
  );
}
