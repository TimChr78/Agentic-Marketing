import { ChevronDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cx } from '../../../ui/cx';

/**
 * A named section in a family editor. The disclosure is native `<details>`, so the fields inside
 * stay mounted (and keep their values) whether it is open or closed; `onFirstOpen` is for work that
 * is deliberately deferred until someone asks for it, such as a rendered preview.
 */
export function EditorSection({
  title,
  hint,
  children,
  defaultOpen = false,
  onFirstOpen,
  className,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  onFirstOpen?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      className={cx('group rounded-lg border border-line bg-surface', className)}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next && !open) onFirstOpen?.();
        setOpen(next);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[16px] leading-6 font-semibold select-none [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronDown size={16} aria-hidden className="shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-line p-4">
        {hint && <p className="text-[12px] leading-[18px] text-muted">{hint}</p>}
        {children}
      </div>
    </details>
  );
}
