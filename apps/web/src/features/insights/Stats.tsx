import type { ReactNode } from 'react';
import { cx, Skeleton, SkeletonRegion } from '../../ui';

// Small KPI cards shared by the insight pages: a label, a tabular number and an optional hint.

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-surface px-3.5 py-3">
      <p className="text-[12px] text-muted">{label}</p>
      <p
        className={cx(
          'mt-0.5 text-[18px] leading-6 font-semibold tabular-nums',
          tone === 'good' && 'text-good',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function StatGrid({ children, className, columns = 6 }: { children: ReactNode; className?: string; columns?: 4 | 6 }) {
  return (
    <div className={cx('grid grid-cols-2 gap-2.5 sm:grid-cols-3', columns === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-6', className)}>
      {children}
    </div>
  );
}

/** The compact StatCard's reserved slot: one label line and one value line, same padding. */
export function StatGridSkeleton({ labels, columns = 6 }: { labels: string[]; columns?: 4 | 6 }) {
  return (
    <StatGrid columns={columns}>
      {labels.map((label) => (
        <SkeletonRegion key={label} label={label} geometry="settings">
          <div className="min-w-0 rounded-md border border-line bg-surface px-3.5 py-3">
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="mt-1.5 h-5 w-2/5" />
          </div>
        </SkeletonRegion>
      ))}
    </StatGrid>
  );
}
