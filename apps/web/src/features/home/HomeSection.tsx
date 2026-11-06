import type { ReactNode } from 'react';
import { cx } from '../../ui/cx';
import { Skeleton } from '../../ui/display';

// One surface per Home section (#447): a heading row and a bordered body with horizontal
// separators. Sublists are rows inside it, never nested outlined cards.

export function HomeSection({
  title,
  meta,
  action,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('min-w-0', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 lg:mb-4">
        <div className="min-w-0">
          <h2 className="text-[16px] leading-6 font-semibold break-words">{title}</h2>
          {meta && <div className="mt-0.5 text-[12px] leading-[18px] text-muted">{meta}</div>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
      <div className="rounded-lg border border-line bg-surface">{children}</div>
    </section>
  );
}

/** A labelled sublist inside a section surface. */
export function HomeBlock({
  label,
  meta,
  footer,
  children,
  className,
}: {
  label: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 bg-surface-2 px-4 py-2.5 md:px-5">
        <p className="text-[12px] leading-[18px] text-muted">{label}</p>
        {meta && <div className="text-[12px] leading-[18px] text-muted">{meta}</div>}
      </div>
      <div className="divide-y divide-line">{children}</div>
      {footer && <div className="border-t border-line px-4 py-2.5 text-[12px] leading-[18px] md:px-5">{footer}</div>}
    </div>
  );
}

/** The shared three-row skeleton for an operational block. */
export function HomeBlockSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={`Loading ${label}`} className="space-y-2.5 px-4 py-4 md:px-5">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex min-h-10 items-center gap-3">
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A loaded-empty line; never a zero count and never a health claim. */
export function HomeBlockEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3 text-[13px] leading-5 text-muted md:px-5">{children}</p>;
}
