import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md';

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:shrink-0';
const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-8 px-3 text-[13px]',
};
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-line-strong bg-surface text-fg hover:bg-surface-2',
  ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg',
  danger: 'border border-bad/50 bg-surface text-bad hover:bg-bad-soft',
  'danger-solid': 'bg-bad text-white hover:brightness-110 [:root[data-theme=dark]_&]:text-[#0e1013]',
};

export function buttonClass({ variant = 'secondary', size = 'md', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cx(base, sizes[size], variants[variant], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks, keeping the button's width. */
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...p },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      {...p}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, className })}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" aria-hidden /> : icon}
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
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', variant = 'ghost', className, type = 'button', ...p },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      {...p}
      className={cx(
        base,
        size === 'sm' ? 'size-7' : 'size-8',
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
  children,
  ...p
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <a {...p} className={buttonClass({ variant, size, className: cx('no-underline', className) })}>
      {icon}
      {children}
    </a>
  );
}
