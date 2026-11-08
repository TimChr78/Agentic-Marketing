import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCapabilities } from '../app/capabilities';
import { cx } from './cx';

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Shown right-aligned, e.g. a shortcut. */
  hint?: ReactNode;
  /** A second-level menu (used by the account menu's Theme submenu). */
  items?: (MenuItem | 'separator')[];
  /** Marks an item that changes data; disabled with the reason in a restricted surface. */
  mutation?: boolean;
}

/**
 * WAI-ARIA menu button: Enter/Space/ArrowDown opens, arrows move, Home/End jump, Esc closes and
 * returns focus. `trigger` receives the props to spread on the button. An item with `items` opens an
 * inline second-level menu, so the account menu can offer Theme without a second overlay.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  label,
  header,
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
  /** Noninteractive content above the items (an account's name, e-mail and role). */
  header?: ReactNode;
}) {
  const id = `m${useId().replace(/:/g, '')}`;
  const { mutations, reason } = useCapabilities();
  const itemState = (it: MenuItem) => {
    const blocked = it.mutation === true && !mutations;
    return { blocked, disabled: it.disabled || blocked, title: blocked ? (reason ?? undefined) : undefined };
  };
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<number | null>(null);
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
    setSubmenu(null);
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    setSubmenu(null);
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
    const onCloseMenus = () => close(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onScroll);
    window.addEventListener('am:close-menus', onCloseMenus);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('am:close-menus', onCloseMenus);
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

  const renderItems = (listItems: (MenuItem | 'separator')[], nested = false) =>
    listItems.map((it, i) => {
      if (it === 'separator')
        // biome-ignore lint/suspicious/noArrayIndexKey: menu definitions are positional lists; separators have no identity
        return <hr key={`s${i}`} className="my-1 h-px border-0 bg-line" />;
      const key = `${nested ? 'n' : ''}${i}`;
      const state = itemState(it);
      if (it.items?.length) {
        const expanded = !nested && submenu === i;
        return (
          <div key={key}>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-haspopup="menu"
              aria-expanded={expanded}
              aria-disabled={state.disabled || undefined}
              title={state.title}
              data-demo-blocked={state.blocked || undefined}
              onClick={() => {
                if (state.disabled) return;
                setSubmenu(expanded ? null : i);
              }}
              className={cx(
                'flex h-10 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] outline-none pointer-coarse:h-10 focus:bg-surface-2 hover:bg-surface-2 md:h-8 md:px-2',
                it.destructive ? 'text-bad' : 'text-fg',
                state.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {it.icon && <span className="text-muted [&_svg]:size-4">{it.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              <ChevronRight size={14} className={cx('shrink-0 text-muted am-motion-transform', expanded && 'rotate-90')} aria-hidden />
            </button>
            {expanded && (
              <div role="menu" aria-label={typeof it.label === 'string' ? it.label : undefined} className="pl-3">
                {renderItems(it.items, true)}
              </div>
            )}
          </div>
        );
      }
      return (
        <button
          key={key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-disabled={state.disabled || undefined}
          title={state.title}
          data-demo-blocked={state.blocked || undefined}
          onClick={() => {
            if (state.disabled) return;
            close();
            it.onSelect?.();
          }}
          className={cx(
            'flex h-10 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] outline-none pointer-coarse:h-10 focus:bg-surface-2 hover:bg-surface-2 md:h-8 md:px-2',
            it.destructive ? 'text-bad' : 'text-fg',
            state.disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          {it.icon && <span className="text-muted [&_svg]:size-4">{it.icon}</span>}
          <span className="min-w-0 flex-1 truncate">{it.label}</span>
          {it.hint && <span className="text-[11px] text-muted">{it.hint}</span>}
        </button>
      );
    });

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
            className="am-fade-in z-[70] min-w-[180px] rounded-lg border border-line bg-surface p-1 shadow-1"
          >
            {header && (
              <div role="presentation" className="border-b border-line px-3 py-2 text-[13px] leading-5">
                {header}
              </div>
            )}
            {renderItems(items)}
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
  const { mutations, reason } = useCapabilities();
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
      className="am-fade-in z-[70] min-w-[180px] rounded-lg border border-line bg-surface p-1 shadow-1"
    >
      {items.map((it, i) => {
        if (it === 'separator') {
          // biome-ignore lint/suspicious/noArrayIndexKey: menu definitions are positional lists; separators have no identity
          return <hr key={i} className="my-1 h-px border-0 bg-line" />;
        }
        const blocked = it.mutation === true && !mutations;
        const disabled = it.disabled || blocked;
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: menu definitions are positional lists; items may repeat a label
            key={i}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={disabled || undefined}
            title={blocked ? (reason ?? undefined) : undefined}
            data-demo-blocked={blocked || undefined}
            onClick={() => {
              if (disabled) return;
              onClose();
              it.onSelect?.();
            }}
            className={cx(
              'flex h-10 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] outline-none pointer-coarse:h-10 focus:bg-surface-2 hover:bg-surface-2 md:h-8 md:px-2',
              it.destructive ? 'text-bad' : 'text-fg',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {it.icon && <span className="text-muted [&_svg]:size-4">{it.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="text-[11px] text-muted">{it.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
