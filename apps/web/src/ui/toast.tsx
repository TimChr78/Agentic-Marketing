import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  message: ReactNode;
  action?: { label: string; onClick: () => void };
}
interface ToastApi {
  success: (message: ReactNode, action?: Toast['action']) => void;
  error: (message: ReactNode, action?: Toast['action']) => void;
  info: (message: ReactNode, action?: Toast['action']) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Toasts (DESIGN.md → Toast): success and info dismiss after 5 s; errors stay until closed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Tone, message: ReactNode, action?: Toast['action']) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, tone, message, action }]);
      if (tone !== 'error') setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (m, a) => push('success', m, a),
      error: (m, a) => push('error', m, a),
      info: (m, a) => push('info', m, a),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
          <div role="status" aria-live="polite" className="contents">
            {toasts
              .filter((t) => t.tone !== 'error')
              .map((t) => (
                <ToastView key={t.id} t={t} onClose={() => dismiss(t.id)} />
              ))}
          </div>
          <div role="alert" aria-live="assertive" className="contents">
            {toasts
              .filter((t) => t.tone === 'error')
              .map((t) => (
                <ToastView key={t.id} t={t} onClose={() => dismiss(t.id)} />
              ))}
          </div>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastView({ t, onClose }: { t: Toast; onClose: () => void }) {
  const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? AlertCircle : Info;
  return (
    <div className="am-rise pointer-events-auto flex w-full max-w-[420px] items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[13px] shadow-1">
      <Icon
        size={16}
        className={cx(
          'mt-0.5 shrink-0',
          t.tone === 'success' && 'text-good',
          t.tone === 'error' && 'text-bad',
          t.tone === 'info' && 'text-accent',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1 break-words">{t.message}</div>
      {t.action && (
        <button
          type="button"
          className="shrink-0 font-medium text-accent hover:underline"
          onClick={() => {
            t.action!.onClick();
            onClose();
          }}
        >
          {t.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" className="-mr-1 shrink-0 rounded p-0.5 text-muted hover:text-fg" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
