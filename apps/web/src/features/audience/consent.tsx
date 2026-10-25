import type { ReactNode } from 'react';
import type { Out } from '../../app/api';
import { StatusPill, Table, Td, Th, THead, Tr, formatDateTime } from '../../ui';

// The consent ledger is append-only: these helpers render one person's records the same way on
// the person page and the consent page.

export type ConsentRecord = Out<'consent.history'>['records'][number];

const tone = { granted: 'good', denied: 'neutral', withdrawn: 'warn', objected: 'bad' } as const;

/** A consent status: text plus colour, never colour alone. */
export function ConsentPill({ status }: { status: string }) {
  return <StatusPill tone={tone[status as keyof typeof tone] ?? 'neutral'}>{label(status)}</StatusPill>;
}

export function label(value: string): string {
  return value ? value.replace(/_/g, ' ') : value;
}

/** What was kept as evidence, in one readable line. */
export function proofText(proof: Record<string, unknown>): string {
  const entries = Object.entries(proof ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${label(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
}

export function ConsentHistoryTable({ records }: { records: ConsentRecord[] }) {
  return (
    <Table label="Consent ledger">
      <THead>
        <tr>
          <Th>Purpose</Th>
          <Th className="hidden md:table-cell">Channel</Th>
          <Th>Choice</Th>
          <Th className="hidden lg:table-cell">Basis</Th>
          <Th>When</Th>
          <Th>Source and proof</Th>
        </tr>
      </THead>
      <tbody>
        {records.map((r, i) => {
          const proof = proofText(r.proof);
          return (
            <Tr key={`${r.recordedAt}-${r.purpose}-${r.channel}-${i}`}>
              <Td className="font-medium text-fg">{label(r.purpose)}</Td>
              <Td className="hidden md:table-cell">{r.channel ? label(r.channel) : 'Any'}</Td>
              <Td>
                <ConsentPill status={r.status} />
              </Td>
              <Td className="hidden lg:table-cell">{label(r.basis)}</Td>
              <Td className="whitespace-nowrap" title={formatDateTime(r.recordedAt)}>
                {formatDateTime(r.recordedAt)}
              </Td>
              <Td className="max-w-[320px]">
                <span className="block">{label(r.source) || 'unknown'}</span>
                {proof && <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted">{proof}</span>}
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** A compact summary of the current choices in a profile, for the people table. */
export function ConsentSummary({ consent }: { consent: { purpose: string; status: string }[] }): ReactNode {
  if (!consent.length) return <span className="text-muted">None recorded</span>;
  const granted = consent.filter((c) => c.status === 'granted').length;
  const other = consent.length - granted;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {granted > 0 && <StatusPill tone="good">{granted} allowed</StatusPill>}
      {other > 0 && (
        <StatusPill tone="warn">
          {other} not allowed
        </StatusPill>
      )}
    </span>
  );
}
