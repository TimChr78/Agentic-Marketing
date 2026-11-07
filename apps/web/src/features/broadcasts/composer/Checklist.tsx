import { AlertTriangle, CheckCircle2, CircleHelp, MinusCircle, RefreshCw } from 'lucide-react';
import { TextLink } from '../../../app/links';
import { Button, formatDateTime, StatusPill, type Tone } from '../../../ui';
import type { CheckRow, CheckStatus } from './model';

const TONE: Record<CheckStatus, Tone> = {
  ready: 'good',
  attention: 'warn',
  'not-checked': 'neutral',
  'not-applicable': 'neutral',
};

const ICON = {
  ready: CheckCircle2,
  attention: AlertTriangle,
  'not-checked': CircleHelp,
  'not-applicable': MinusCircle,
} as const;

/**
 * The four evidence rows (#497). They describe what has been checked; the server's validation and
 * publish policy stay authoritative. Nothing here blocks Save, and no row is green because a
 * diagnostic was skipped.
 */
export function Checklist({
  rows,
  onRefresh,
  onRetry,
  refreshing,
  checkedAt,
}: {
  rows: CheckRow[];
  onRefresh: () => void;
  onRetry: (key: CheckRow['key']) => void;
  refreshing: boolean;
  checkedAt: string | null;
}) {
  return (
    <section aria-labelledby="composer-checks-title" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 id="composer-checks-title" className="text-[14px] leading-5 font-semibold">
            Pre-send checks
          </h3>
          {checkedAt && (
            <p className="mt-0.5 text-[12px] leading-[18px] text-muted">DNS checked {formatDateTime(checkedAt, { zone: true })}</p>
          )}
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden />} loading={refreshing} onClick={onRefresh}>
          Refresh checks
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((row) => {
          const Icon = ICON[row.status];
          return (
            <li key={row.key} className="px-4 py-3" data-check={row.key} data-check-status={row.status}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <b className="text-[13px] leading-5 font-medium text-fg">{row.label}</b>
                <StatusPill tone={TONE[row.status]} dot={false}>
                  <Icon size={12} aria-hidden />
                  {row.statusLabel}
                </StatusPill>
              </div>
              {row.details.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[12px] leading-[18px] break-words text-muted">
                  {row.details.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {row.link && (
                <p className="mt-1 text-[12px] leading-[18px]">
                  <TextLink to={row.link.to}>{row.link.label}</TextLink>
                </p>
              )}
              {row.retry && (
                <Button size="sm" variant="ghost" className="mt-1" onClick={() => onRetry(row.key)}>
                  Retry
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
