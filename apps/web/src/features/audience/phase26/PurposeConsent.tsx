import { StatusPill } from '../../../ui';
import { CopyPurposeKey } from './CopyControl';
import { basisLabel, consentLabel, consentTone, type PurposeRow } from './model';

// Consent per purpose. The shared consent helpers stay frozen; this surface needs the plain
// "Allowed" wording and the purpose's lawful-basis context, and it never turns missing records
// into an aggregate ("1 allowed") or a refusal.

function PurposeLabel({ row }: { row: PurposeRow }) {
  if (row.name) return <span className="font-medium text-fg">{row.name}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium text-fg">Purpose name unavailable</span>
      <CopyPurposeKey purposeKey={row.key} />
    </span>
  );
}

export function ConsentChoice({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted">No recorded choice</span>;
  return <StatusPill tone={consentTone(status)}>{consentLabel(status)}</StatusPill>;
}

export function PurposeConsentList({
  rows,
  showContext = false,
  label = 'Consent per purpose',
  className,
}: {
  rows: readonly PurposeRow[];
  /** Adds the lawful basis and channel from the permitted purposes artifact. */
  showContext?: boolean;
  label?: string;
  className?: string;
}) {
  if (!rows.length) return <span className="text-muted">No purposes in force</span>;
  return (
    <ul aria-label={label} className={className ?? 'space-y-1.5'}>
      {rows.map((row) => {
        const basis = showContext ? basisLabel(row.basis) : null;
        const context = [basis, row.channel].filter(Boolean).join(' · ');
        return (
          <li key={row.key} className="min-w-0 text-[13px] leading-5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <PurposeLabel row={row} />
              <span data-volatile className="inline-flex">
                <ConsentChoice status={row.status} />
              </span>
            </div>
            {context && <div className="mt-0.5 text-[12px] leading-[18px] text-muted">{context}</div>}
          </li>
        );
      })}
    </ul>
  );
}
