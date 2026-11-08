import { Loader2 } from 'lucide-react';
import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { useCapabilities } from '../app/capabilities';
import { routerHref } from '../app/router';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md';

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none am-motion-colors disabled:cursor-not-allowed disabled:border-control disabled:bg-surface-2 disabled:text-muted disabled:opacity-100 disabled:hover:bg-surface-2 disabled:hover:text-muted [&_svg]:shrink-0';
// v2 control sizes: 28/32 px on desktop, both 40 px below 768 px and on coarse pointers (DESIGN.md).
const sizes: Record<ButtonSize, string> = {
  sm: 'h-10 px-3 text-[13px] pointer-coarse:h-10 pointer-coarse:px-3 md:h-7 md:px-2.5 md:text-[12px]',
  md: 'h-10 px-3 text-[13px] pointer-coarse:h-10 pointer-coarse:px-3 md:h-8 md:px-3',
};
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-line-strong bg-surface text-fg hover:bg-surface-2',
  ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg',
  danger: 'border border-bad/50 bg-surface text-bad hover:bg-bad-soft',
  'danger-solid': 'bg-bad text-white hover:brightness-110 [:root[data-theme=dark]_&]:text-[var(--bg)]',
};

/** The static progress glyph's box; the idle button reserves it so the busy state cannot resize it. */
const PROGRESS_GLYPH = { sm: 14, md: 16 } as const;

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return cx(base, sizes[size], variants[variant], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks, keeping the button's width. */
  loading?: boolean;
  icon?: ReactNode;
  /**
   * Marks a control that changes data. In a restricted surface (the demo) it renders disabled and
   * carries the reason as its description; outside one it is unchanged.
   */
  mutation?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, mutation, className, children, disabled, type = 'button', ...p },
  ref,
) {
  const { mutations, reason } = useCapabilities();
  const blocked = mutation === true && !mutations;
  const glyph = PROGRESS_GLYPH[size];
  // A button that can show the progress glyph reserves its slot even when idle, so the busy state
  // never changes the button's width (skeletons-and-budgets.md, #555 review). A button that never
  // takes `loading` keeps its existing layout untouched.
  const hasSlot = loading !== undefined || icon !== undefined;
  const reserve = icon === undefined && !loading;
  return (
    <button
      ref={ref}
      type={type}
      {...p}
      title={blocked ? (reason ?? p.title) : p.title}
      aria-description={blocked ? (reason ?? undefined) : p['aria-description']}
      disabled={disabled || loading || blocked}
      data-demo-blocked={blocked || undefined}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, className })}
    >
      {hasSlot && (
        <span
          className="inline-flex shrink-0 items-center justify-center"
          data-button-slot=""
          aria-hidden={reserve || undefined}
          style={reserve ? { width: glyph, height: glyph } : undefined}
        >
          {loading ? <Loader2 size={glyph} className="am-progress" aria-hidden /> : icon}
        </span>
      )}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: the accessible name, also shown as a tooltip. */
  label: string;
  icon: ReactNode;
  size?: ButtonSize;
  variant?: 'ghost' | 'secondary' | 'danger';
  /** Marks a control that changes data; disabled with the reason in a restricted surface. */
  mutation?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', variant = 'ghost', mutation, className, type = 'button', ...p },
  ref,
) {
  const { mutations, reason } = useCapabilities();
  const blocked = mutation === true && !mutations;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={blocked ? `${label} · ${reason ?? 'Unavailable'}` : label}
      aria-description={blocked ? (reason ?? undefined) : p['aria-description']}
      {...p}
      disabled={p.disabled || blocked}
      data-demo-blocked={blocked || undefined}
      className={cx(
        base,
        size === 'sm' ? 'size-10 pointer-coarse:size-10 md:size-7' : 'size-10 pointer-coarse:size-10 md:size-8',
        variant === 'ghost' && 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        variant === 'secondary' && 'border border-line-strong bg-surface text-fg hover:bg-surface-2',
        variant === 'danger' && 'text-bad hover:bg-bad-soft',
        className,
      )}
    >
      {icon}
    </button>
  );
});

/** An anchor styled as a button (navigation, downloads). */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  className,
  icon,
  href,
  children,
  ...p
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <a
      {...p}
      href={href ? routerHref(href) : undefined}
      className={buttonClass({ variant, size, className: cx('no-underline', className) })}
    >
      {icon}
      {children}
    </a>
  );
}
