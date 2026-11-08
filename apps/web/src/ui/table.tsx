import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from './cx';
import { Alert, EmptyState } from './display';
import { ListSkeleton } from './Skeleton';

// Tables (DESIGN.md → Table): the frame handles loading (skeleton rows), error (inline alert with
// the reason and Retry) and empty (an EmptyState inside the frame), so every list behaves the same.

export function TableFrame({
  children,
  loading,
  error,
  onRetry,
  empty,
  isEmpty,
  columns = 4,
  className,
  toolbar,
  footer,
  loadingLabel = 'Loading list',
}: {
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Rendered when `isEmpty` (and not loading or failed). */
  empty?: ReactNode;
  isEmpty?: boolean;
  columns?: number;
  className?: string;
  toolbar?: ReactNode;
  /** Paging or summary row after the table, outside the horizontal scroll region. */
  footer?: ReactNode;
  /** The object-specific busy label, e.g. "Loading invitations". */
  loadingLabel?: string;
}) {
  return (
    <div className={cx('am-frame min-w-0 overflow-hidden rounded-lg border border-line bg-surface', className)}>
      {toolbar && <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 md:px-4">{toolbar}</div>}
      {error ? (
        <div className="p-3">
          <Alert tone="bad" title="Couldn't load this list" onRetry={onRetry}>
            {error}
          </Alert>
        </div>
      ) : loading ? (
        <ListSkeleton label={loadingLabel} columns={columns} />
      ) : isEmpty ? (
        empty
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
      {footer && !error && !loading && <div className="border-t border-line px-3 py-2.5 md:px-4">{footer}</div>}
    </div>
  );
}

export function Table({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <table aria-label={label} className={cx('w-full border-collapse text-left text-[13px] leading-5', className)}>
      {children}
    </table>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-surface-2 text-[13px] leading-5 text-muted">{children}</thead>;
}

export function Th({ className, align, ...p }: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'right' }) {
  return (
    <th scope="col" {...p} className={cx('h-9 px-3 font-medium whitespace-nowrap md:px-4', align === 'right' && 'text-right', className)} />
  );
}

export function Tr({
  children,
  onClick,
  selected,
  className,
  href,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  href?: string;
}) {
  return (
    <tr
      onClick={onClick}
      aria-selected={selected || undefined}
      data-href={href}
      className={cx(
        'border-t border-line',
        (onClick || href) && 'cursor-pointer hover:bg-surface-2',
        selected && 'bg-surface-2',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({ className, align, ...p }: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'right' }) {
  return (
    <td
      {...p}
      className={cx('px-3 py-3.5 align-middle text-[13px] leading-5 text-fg-2 md:px-4', align === 'right' && 'num text-right', className)}
    />
  );
}

/** The empty state used inside a TableFrame. */
export function TableEmpty(props: Parameters<typeof EmptyState>[0]) {
  return <EmptyState {...props} />;
}
