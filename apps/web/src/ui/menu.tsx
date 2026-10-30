import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';

export interface MenuItem {
  label: ReactNode;
  onSelect: () => void;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Shown right-aligned, e.g. a shortcut. */
  hint?: ReactNode;
}

/**
 * WAI-ARIA menu button: Enter/Space/ArrowDown opens, arrows move, Home/End jump, Esc closes and
 * returns focus. `trigger` receives the props to spread on the button.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  label,
}: {
  trigger: (p: {
    ref: (el: HTMLButtonElement | null) => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
    onClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  }) => ReactNode;
  items: (MenuItem | 'separator')[];
  align?: 'start' | 'end';
  label?: string;
}) {
  const id = `m${useId().replace(/:/g, '')}`;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const btn = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<'first' | 'last'>('first');

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    setPos(align === 'end' ? { top: r.bottom + 4, right: window.innerWidth - r.right } : { top: r.bottom + 4, left: r.left });
  };
  const openMenu = (focus: 'first' | 'last' = 'first') => {
    firstFocus.current = focus;
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const enabled = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: open/close helpers are recreated each render; the menu only wires listeners when it opens
  useEffect(() => {
    if (!open) return;
    const els = enabled();
    (firstFocus.current === 'first' ? els[0] : els[els.length - 1])?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const onListKey = (e: React.KeyboardEvent) => {
    const els = enabled();
    const i = els.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % els.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + els.length) % els.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = els.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    } else if (e.key === 'Tab') {
      close(false);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      els[next]?.focus();
    }
  };

  return (
    <>
      {trigger({
        ref: (el) => {
          btn.current = el;
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
        onClick: () => (open ? close(false) : openMenu()),
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu('first');
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu('last');
          }
        },
      })}
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="menu"
            aria-label={label}
            onKeyDown={onListKey}
            style={{ position: 'fixed', top: pos.top, left: pos.left, right: pos.right }}
            className="am-fade-in z-[70] min-w-[180px] rounded-lg border border-line bg-surface p-1 shadow-2"
          >
            {items.map((it, i) =>
              it === 'separator' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: menu definitions are positional lists; separators have no identity
                <hr key={i} className="my-1 h-px border-0 bg-line" />
              ) : (
                <button
                  key={
                    // biome-ignore lint/suspicious/noArrayIndexKey: menu definitions are positional lists; items may repeat a label
                    i
                  }
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={it.disabled || undefined}
                  onClick={() => {
                    if (it.disabled) return;
                    close();
                    it.onSelect();
                  }}
                  className={cx(
                    'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus:bg-surface-2 hover:bg-surface-2',
                    it.destructive ? 'text-bad' : 'text-fg',
                    it.disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {it.icon && <span className="text-muted [&_svg]:size-4">{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="text-[11px] text-muted">{it.hint}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A context menu opened at the pointer (or at an element for keyboard users). */
export function ContextMenu({
  at,
  items,
  onClose,
  label,
}: {
  at: { x: number; y: number } | null;
  items: (MenuItem | 'separator')[];
  onClose: () => void;
  label?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!at) return;
    const prev = document.activeElement as HTMLElement | null;
    list.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener('mousedown', onDoc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      prev?.focus?.();
    };
  }, [at]);
  if (!at) return null;
  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
    }
  };
  return createPortal(
    <div
      ref={list}
      role="menu"
      aria-label={label}
      onKeyDown={onKey}
      style={{
        position: 'fixed',
        top: Math.min(Number.isFinite(at.y) ? at.y : window.innerHeight / 3, window.innerHeight - 220),
        left: Math.min(Number.isFinite(at.x) ? at.x : window.innerWidth / 3, window.innerWidth - 200),
      }}
      className="am-fade-in z-[70] min-w-[180px] rounded-lg border border-line bg-surface p-1 shadow-2"
    >
      {items.map((it, i) =>
        it === 'separator' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: menu definitions are positional lists; separators have no identity
          <hr key={i} className="my-1 h-px border-0 bg-line" />
        ) : (
          <button
            key={
              // biome-ignore lint/suspicious/noArrayIndexKey: menu definitions are positional lists; items may repeat a label
              i
            }
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={it.disabled || undefined}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onSelect();
            }}
            className={cx(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus:bg-surface-2 hover:bg-surface-2',
              it.destructive ? 'text-bad' : 'text-fg',
              it.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {it.icon && <span className="text-muted [&_svg]:size-4">{it.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="text-[11px] text-muted">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
