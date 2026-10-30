import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { cx } from './cx';

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
  /** A shorter label under 640 px, where a long row would scroll off screen (#62). */
  shortLabel?: ReactNode;
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
  compact,
}: {
  items: TabItem<K>[];
  value: K;
  onChange: (k: K) => void;
  children?: ReactNode;
  className?: string;
  label?: string;
  /** Tighter padding and type, for a narrow panel (the journey inspector). */
  compact?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);
  // Show a fade at an edge only while there is more tab row to scroll to (#62).
  const [fade, setFade] = useState({ left: false, right: false });
  const updateFade = useCallback(() => {
    const el = list.current;
    if (!el) return;
    setFade({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabs changing can change the row width, so re-check the fade edges
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    updateFade();
    el.addEventListener('scroll', updateFade, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFade);
    observer?.observe(el);
    window.addEventListener('resize', updateFade);
    return () => {
      el.removeEventListener('scroll', updateFade);
      observer?.disconnect();
      window.removeEventListener('resize', updateFade);
    };
  }, [updateFade, items.length]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = items.length;
    const next =
      e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].key);
  };
  return (
    <div className={className}>
      <div className="relative">
        <div
          ref={list}
          role="tablist"
          aria-label={label}
          className={cx('flex overflow-x-auto border-b border-line', compact ? 'gap-0.5' : 'gap-1')}
        >
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
                'focus-inset -mb-px inline-flex h-9 shrink-0 items-center border-b-2 font-medium whitespace-nowrap transition-colors',
                compact ? 'gap-1 px-1.5 text-[12px]' : 'gap-1.5 px-2.5 text-[13px]',
                value === t.key ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {t.shortLabel ? (
                <>
                  <span className="sm:hidden">{t.shortLabel}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                </>
              ) : (
                t.label
              )}
              {t.count !== undefined && (
                <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-fg-2 tabular-nums">{t.count}</span>
              )}
            </button>
          ))}
        </div>
        {fade.left && (
          <span
            aria-hidden
            data-scroll-fade="left"
            className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-fg/10 to-transparent"
          />
        )}
        {fade.right && (
          <span
            aria-hidden
            data-scroll-fade="right"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-fg/10 to-transparent"
          />
        )}
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
export function Segmented<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { key: K; label: ReactNode; icon?: ReactNode }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
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
