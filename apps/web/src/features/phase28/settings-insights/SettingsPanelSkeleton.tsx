import { cx, Skeleton, SkeletonRegion } from '../../../ui';

// Phase 28 (#560) reserved slots for Settings and token detail screens. They keep the existing
// label, control and hint line boxes and never fetch; the caller owns the read and the label.

/** A settings/detail panel: two label-control-hint groups and the save row. */
export function SettingsPanelSkeleton({ label, className }: { label: string; className?: string }) {
  return (
    <SkeletonRegion label={label} geometry="settings" className={cx('space-y-5 p-5', className)}>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-full max-w-[420px] rounded-md" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-full max-w-[420px] rounded-md" />
      </div>
      <Skeleton className="h-8 w-28 rounded-md" />
    </SkeletonRegion>
  );
}

/** One provider channel's rows while that channel's own read is pending. */
export function SettingsRowsSkeleton({ label, rows = 2 }: { label: string; rows?: number }) {
  return (
    <SkeletonRegion label={label} geometry="list" className="space-y-3 p-2">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: generated placeholder rows have no identity and never reorder
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </SkeletonRegion>
  );
}
