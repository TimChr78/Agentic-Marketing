import { AlertCircle, AlertTriangle, Bot, CheckCircle2, Info, KeyRound, RefreshCw, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './cx';

// Display primitives: status pills, badges, empty states, skeletons, inline alerts, page layout.

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-2',
  info: 'bg-accent-soft text-accent',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
};
const dotClass: Record<Tone, string> = {
  neutral: 'bg-muted',
  info: 'bg-accent',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

/** A status: always text plus colour, never colour alone. */
export function StatusPill({
  tone = 'neutral',
  children,
  className,
  dot = true,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap',
        toneClass[tone],
        className,
      )}
    >
      {dot && <span className={cx('size-1.5 rounded-full', dotClass[tone])} aria-hidden />}
      {children}
    </span>
  );
}

export type VersionState = 'draft' | 'in_review' | 'published' | 'superseded' | 'rejected';
export const versionState: Record<VersionState, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  in_review: { tone: 'warn', label: 'In review' },
  published: { tone: 'good', label: 'Live' },
  superseded: { tone: 'neutral', label: 'Superseded' },
  rejected: { tone: 'bad', label: 'Rejected' },
};
export function StatePill({ state, className }: { state: VersionState; className?: string }) {
  const s = versionState[state] ?? { tone: 'neutral' as const, label: state };
  return (
    <StatusPill tone={s.tone} className={className}>
      {s.label}
    </StatusPill>
  );
}

/** A neutral label for kinds and types ("E-mail template"). */
export function Tag({ children, className, icon }: { children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 text-[11px] font-medium whitespace-nowrap text-fg-2',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  label,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn';
  label?: string;
}) {
  return (
    <span
      aria-label={label}
      className={cx(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
        tone === 'neutral' && 'bg-surface-3 text-fg-2',
        tone === 'accent' && 'bg-accent text-accent-fg',
        tone === 'warn' && 'bg-warn-soft text-warn',
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-line-strong bg-surface px-1 font-sans text-[11px] text-muted">
      {children}
    </kbd>
  );
}

/** Who did something: a person, an agent (OAuth client) or an API token. Identity, not status: no colour. */
export function Actor({
  kind,
  name,
  detail,
  className,
}: {
  kind: 'person' | 'agent' | 'token';
  name: string;
  detail?: string;
  className?: string;
}) {
  const Icon = kind === 'person' ? User : kind === 'token' ? KeyRound : Bot;
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5 text-fg-2', className)}>
      <Icon size={14} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 break-words">
        {kind !== 'person' && <span className="sr-only">{kind === 'token' ? 'API token' : 'Agent'}: </span>}
        {name}
        {detail && <span className="text-muted"> · {detail}</span>}
      </span>
      {kind !== 'person' && (
        <span className="shrink-0 rounded-sm bg-surface-2 px-1 text-[11px] font-medium text-muted" aria-hidden>
          Agent
        </span>
      )}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
  icon,
  compact,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('flex flex-col items-center px-6 text-center', compact ? 'py-6' : 'py-12')}>
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <p className="text-[14px] font-medium text-fg">{title}</p>
      {children && <div className="mt-1 max-w-[440px] text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cx('am-skeleton block h-3.5', className)} aria-hidden />;
}

/** Skeleton lines in place of loading content, announced once to screen readers. */
export function LoadingBlock({ lines = 4, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="space-y-2.5 p-4" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={i % 3 === 2 ? 'w-2/5' : i % 2 ? 'w-4/5' : 'w-3/5'} />
      ))}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  onRetry,
  action,
  className,
}: {
  tone?: 'info' | 'warn' | 'bad' | 'good';
  title?: ReactNode;
  children?: ReactNode;
  onRetry?: () => void;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = tone === 'bad' ? AlertCircle : tone === 'warn' ? AlertTriangle : tone === 'good' ? CheckCircle2 : Info;
  return (
    <div
      role={tone === 'bad' ? 'alert' : undefined}
      className={cx(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]',
        tone === 'info' && 'border-accent/25 bg-accent-soft',
        tone === 'warn' && 'border-warn/30 bg-warn-soft',
        tone === 'bad' && 'border-bad/30 bg-bad-soft',
        tone === 'good' && 'border-good/30 bg-good-soft',
        className,
      )}
    >
      <Icon
        size={16}
        className={cx(
          'mt-0.5 shrink-0',
          tone === 'info' && 'text-accent',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
          tone === 'good' && 'text-good',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1 break-words text-fg">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cx(!!title && 'mt-0.5', 'text-fg-2')}>{children}</div>}
      </div>
      {action}
      {onRetry && (
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Card({
  children,
  className,
  title,
  description,
  action,
  padded,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  padded?: boolean;
}) {
  return (
    <section
      className={cx('min-w-0 rounded-lg border border-line bg-surface [&>.am-frame]:rounded-t-none [&>.am-frame]:border-0', className)}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[14px] leading-5 font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-[12px] text-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      {padded ? <div className="p-4">{children}</div> : children}
    </section>
  );
}

/** Page header: title, one-line description, primary action top right (DESIGN.md → Layout). */
export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[20px] leading-7 font-semibold break-words">{title}</h1>
        {meta && <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">{meta}</div>}
        {description && <p className="mt-1 max-w-[720px] text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A labelled value in a definition list. */
export function Meta({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[minmax(96px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx('rounded-sm bg-surface-2 px-1 py-px font-mono text-[12px] text-fg', className)}>{children}</code>;
}
