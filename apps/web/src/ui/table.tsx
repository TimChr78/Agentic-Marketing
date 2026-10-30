import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from './cx';
import { Alert, EmptyState, Skeleton } from './display';

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
}) {
  return (
    <div className={cx('am-frame min-w-0 overflow-hidden rounded-lg border border-line bg-surface', className)}>
      {toolbar && <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">{toolbar}</div>}
      {error ? (
        <div className="p-3">
          <Alert tone="bad" title="Couldn't load this list" onRetry={onRetry}>
            {error}
          </Alert>
        </div>
      ) : loading ? (
        <div role="status" aria-label="Loading">
          {Array.from({ length: 5 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: loading placeholder rows are generated, never reordered, and have no identity
            <div key={i} className="flex gap-4 border-b border-line px-4 py-3 last:border-0">
              {Array.from({ length: columns }, (_, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: loading placeholder cells are positional columns of a generated row
                <Skeleton key={c} className={cx('h-3.5', c === 0 ? 'w-1/3' : 'w-1/6')} />
              ))}
            </div>
          ))}
        </div>
      ) : isEmpty ? (
        empty
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </div>
  );
}

export function Table({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <table aria-label={label} className={cx('w-full border-collapse text-left text-[13px]', className)}>
      {children}
    </table>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-surface-2 text-[12px] text-muted">{children}</thead>;
}

export function Th({ className, align, ...p }: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'right' }) {
  return <th scope="col" {...p} className={cx('h-9 px-4 font-medium whitespace-nowrap', align === 'right' && 'text-right', className)} />;
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
  return <td {...p} className={cx('px-4 py-2.5 align-middle text-fg-2', align === 'right' && 'num text-right', className)} />;
}

/** The empty state used inside a TableFrame. */
export function TableEmpty(props: Parameters<typeof EmptyState>[0]) {
  return <EmptyState {...props} />;
}
