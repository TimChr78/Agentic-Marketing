import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './Button';
import { cx } from './cx';
import { useFocusTrap } from './focus';
import { Field, Input } from './form';

function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One line under the title: type, state, ids. */
  meta?: ReactNode;
  children: ReactNode;
  /** Sticky footer, usually the actions. */
  footer?: ReactNode;
  /** Width on large screens. Under 640 px a drawer is full screen. */
  width?: 'md' | 'lg' | 'xl';
  /** Extra header actions next to the close button. */
  actions?: ReactNode;
}

/** Right-side dialog (DESIGN.md → Drawer): focus trapped, Esc closes, focus returns to the trigger. */
export function Drawer({ open, onClose, title, meta, children, footer, width = 'md', actions }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // A drawer opens on its content (screen readers read the title); Tab then reaches the controls.
  useFocusTrap(ref, open, onClose, 'container');
  useBodyScrollLock(open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="am-fade-in absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'am-drawer-in relative flex h-full w-full flex-col border-l border-line bg-surface shadow-2 outline-none',
          width === 'md' && 'sm:max-w-[560px]',
          width === 'lg' && 'sm:max-w-[760px]',
          width === 'xl' && 'sm:max-w-[min(1080px,92vw)]',
        )}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] leading-[22px] font-semibold break-words">
              {title}
            </h2>
            {meta && <div className="mt-0.5 text-[12px] text-muted">{meta}</div>}
          </div>
          {actions}
          <IconButton label="Close" icon={<X size={16} />} onClick={onClose} className="-mr-1.5" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  role?: 'dialog' | 'alertdialog';
  /** md: 480 px (confirmations, short forms); lg: 760 px (pickers). */
  size?: 'md' | 'lg';
}

export function Modal({ open, onClose, title, children, footer, role = 'dialog', size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, onClose);
  useBodyScrollLock(open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="am-fade-in absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'am-rise relative flex max-h-[92vh] w-full flex-col rounded-t-xl border border-line bg-surface shadow-2 outline-none sm:rounded-xl',
          size === 'lg' ? 'max-w-[760px]' : 'max-w-[480px]',
        )}
      >
        <h2 id={titleId} className="px-5 pt-4 text-[15px] leading-[22px] font-semibold">
          {title}
        </h2>
        <div className="min-h-0 overflow-y-auto px-5 pt-2 pb-4 text-[14px] leading-[22px] text-fg-2">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** The confirm button says the action, e.g. "Delete provider". Never "OK". */
  confirmLabel: string;
  destructive?: boolean;
  /** Require typing this text (the object's name) for irreversible or high-impact actions. */
  typeToConfirm?: string;
}

/**
 * `const confirm = useConfirm()` returns `[dialog, ask]`: render `dialog`, and `await ask({...})`
 * resolves to true when the person confirms.
 */
export function useConfirm(): [ReactNode, (o: ConfirmOptions) => Promise<boolean>] {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const ask = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setState({ ...o, resolve });
      }),
    [],
  );
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const blocked = !!state?.typeToConfirm && typed.trim() !== state.typeToConfirm;
  const dialog = (
    <Modal
      open={!!state}
      onClose={() => close(false)}
      role="alertdialog"
      title={state?.title ?? ''}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button
            variant={state?.destructive ? 'danger-solid' : 'primary'}
            disabled={blocked}
            onClick={() => close(true)}
            data-autofocus={!state?.typeToConfirm || undefined}
          >
            {state?.confirmLabel}
          </Button>
        </>
      }
    >
      {state?.body}
      {state?.typeToConfirm && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked) close(true);
          }}
        >
          <Field
            label={
              <>
                Type <strong className="font-semibold text-fg">{state.typeToConfirm}</strong> to confirm
              </>
            }
          >
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />
          </Field>
        </form>
      )}
    </Modal>
  );
  return [dialog, ask];
}
