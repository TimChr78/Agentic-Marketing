import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { cx } from './cx';

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
  count?: number;
}

/** WAI-ARIA tabs: arrow keys move between tabs, Home/End jump; the panel is labelled by its tab. */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  children,
  className,
  label,
}: {
  items: TabItem<K>[];
  value: K;
  onChange: (k: K) => void;
  children?: ReactNode;
  className?: string;
  label?: string;
}) {
  const id = useId().replace(/:/g, '');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = items.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].key);
  };
  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
        {items.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${t.key}`}
            aria-selected={value === t.key}
            aria-controls={`${id}-panel`}
            tabIndex={value === t.key ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              'focus-inset -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              value === t.key ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-fg-2 tabular-nums">{t.count}</span>}
          </button>
        ))}
      </div>
      {children !== undefined && (
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${value}`} className="pt-4">
          {children}
        </div>
      )}
    </div>
  );
}

/** Segmented control for 2–4 view options (e.g. Desktop / Mobile). */
export function Segmented<K extends string>({ items, value, onChange, label }: { items: { key: K; label: ReactNode; icon?: ReactNode }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line-strong bg-surface-2 p-0.5">
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="radio"
          aria-checked={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            'inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[12px] font-medium transition-colors',
            value === t.key ? 'bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-muted hover:text-fg',
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}
