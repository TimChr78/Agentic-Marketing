import type { ReactNode } from 'react';
import { type ButtonSize, type ButtonVariant, buttonClass, cx } from '../ui';
import { Link } from './router';

/** An in-app link that looks like a button (navigates without reloading). */
export function ButtonLink({ to, variant = 'secondary', size = 'md', icon, children, className }: { to: string; variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={buttonClass({ variant, size, className: cx('no-underline', className) })}>
      {icon}
      {children}
    </Link>
  );
}

/** An in-app text link in the accent colour. */
export function TextLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cx('font-medium text-accent hover:underline', className)}>
      {children}
    </Link>
  );
}
