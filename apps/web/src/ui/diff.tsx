import { cx } from './cx';
import { EmptyState, StatusPill } from './display';

export interface DiffChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/**
 * Field-level diff (DESIGN.md → Diff view): one row per changed path with the old value struck
 * and the new value below. Added/removed/changed are labelled in text, not colour alone.
 */
export function DiffView({ changes, from, to, className }: { changes: DiffChange[]; from?: number | null; to?: number; className?: string }) {
  if (changes.length === 0) return <EmptyState compact title="No changes">This version is identical to {from ? `v${from}` : 'the previous one'}.</EmptyState>;
  return (
    <div className={cx('min-w-0 rounded-md border border-line', className)}>
      {to !== undefined && (
        <div className="border-b border-line bg-surface-2 px-3 py-1.5 text-[12px] text-muted">
          {from ? `v${from} (live) → v${to}` : `New, v${to}`} · {changes.length} {changes.length === 1 ? 'change' : 'changes'}
        </div>
      )}
      <ul className="divide-y divide-line">
        {changes.map((c) => (
          <li key={c.path} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <StatusPill dot={false} tone={c.kind === 'added' ? 'good' : c.kind === 'removed' ? 'bad' : 'info'}>
                {c.kind === 'added' ? 'Added' : c.kind === 'removed' ? 'Removed' : 'Changed'}
              </StatusPill>
              <code className="min-w-0 truncate font-mono text-[12px] text-fg-2">{c.path || '(root)'}</code>
            </div>
            <div className="mt-1.5 space-y-1 font-mono text-[12px] leading-[18px]">
              {c.before !== undefined && (
                <pre className="overflow-x-auto rounded-sm bg-bad-soft px-2 py-1 whitespace-pre-wrap break-words text-fg">
                  <span className="sr-only">Before: </span>
                  <span aria-hidden className="mr-1 text-bad">−</span>
                  {fmt(c.before)}
                </pre>
              )}
              {c.after !== undefined && (
                <pre className="overflow-x-auto rounded-sm bg-good-soft px-2 py-1 whitespace-pre-wrap break-words text-fg">
                  <span className="sr-only">After: </span>
                  <span aria-hidden className="mr-1 text-good">+</span>
                  {fmt(c.after)}
                </pre>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
