import { Bot, User } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Principal } from '../api/types';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'agent';
export function Button({ variant = 'secondary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface text-fg hover:bg-surface-2',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-fg',
        variant === 'danger' && 'border border-bad/40 text-bad hover:bg-bad-soft',
        variant === 'agent' && 'bg-agent-soft text-agent border border-agent/30 hover:brightness-105',
        className,
      )}
    />
  );
}

type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'agent';
export function Pill({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        tone === 'neutral' && 'bg-surface-2 text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'good' && 'bg-good-soft text-good',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'bad' && 'bg-bad-soft text-bad',
        tone === 'agent' && 'bg-agent-soft text-agent',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function AuthorBadge({ author }: { author: Principal }) {
  return author.type === 'agent' ? (
    <Pill tone="agent">
      <Bot size={12} /> {author.name}
    </Pill>
  ) : (
    <Pill>
      <User size={12} /> {author.name}
    </Pill>
  );
}

export function Card({
  children,
  className,
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface min-w-0', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h3 className="text-[14px] font-semibold" style={{ fontFamily: 'var(--font-sans)' }}>
            {title}
          </h3>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 pb-5">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="text-[26px] font-bold leading-tight">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Kpi({ label, value, delta, hint }: { label: string; value: string; delta?: number; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="num mt-1 text-[24px] font-semibold leading-none" style={{ fontFamily: 'var(--font-display)' }}>
        {value}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
        {delta !== undefined && (
          <span className={cx('num font-semibold', delta >= 0 ? 'text-good' : 'text-bad')}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
        {hint}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputBase =
  'rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-fg placeholder:text-muted focus:border-accent focus:outline-none';
export const inputCls = `${inputBase} w-full`;

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx('font-mono text-[12px]', className)}>{children}</code>;
}

export function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const dkk = (n: number) => `${Math.round(n).toLocaleString('da-DK')} kr`;
