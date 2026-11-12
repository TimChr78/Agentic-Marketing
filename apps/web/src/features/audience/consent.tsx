import type { ReactNode } from 'react';
import type { Out } from '../../app/api';
import { PURPOSE_LABEL } from '../../lib/labels';
import { formatDateTime, StatusPill, Table, Td, THead, Th, Tr } from '../../ui';
import { CopyPurposeKey } from './phase26/CopyControl';

// The consent ledger is append-only: these helpers render one person's records the same way on
// the person page and the consent page.

export type ConsentRecord = Out<'consent.history'>['records'][number];

const tone = { granted: 'good', denied: 'neutral', withdrawn: 'warn', objected: 'bad' } as const;

const STATUS_LABEL: Record<string, string> = {
  granted: 'Granted',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  objected: 'Objected',
};

const BASIS_LABEL: Record<string, string> = {
  consent: 'Consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
};

const CHANNEL_LABEL: Record<string, string> = {
  email: 'E-mail',
  web: 'Web',
  sms: 'SMS',
  push: 'Push',
  webhook: 'Webhook',
};

const SOURCE_LABEL: Record<string, string> = {
  form: 'Form',
  import: 'Import',
  api: 'API or agent',
  unsubscribe: 'Unsubscribe',
};

/** A consent status: text plus colour, never colour alone. */
export function ConsentPill({ status }: { status: string }) {
  return <StatusPill tone={tone[status as keyof typeof tone] ?? 'neutral'}>{STATUS_LABEL[status] ?? label(status)}</StatusPill>;
}

export function label(value: string): string {
  return value ? value.replace(/_/g, ' ') : value;
}

const named = (value: string | null | undefined, labels: Record<string, string>) => (value ? (labels[value] ?? label(value)) : '');

/** A purpose in the workspace's own words, never its technical key in ordinary label position. */
export function PurposeName({ purpose, purposes }: { purpose: string; purposes?: readonly { key: string; name: string }[] }) {
  const name = purposes?.find((p) => p.key === purpose)?.name ?? PURPOSE_LABEL[purpose];
  if (name) return <>{name}</>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      Unavailable purpose
      <CopyPurposeKey purposeKey={purpose} />
    </span>
  );
}

/** What was kept as evidence, in one readable line. */
export function proofText(proof: Record<string, unknown>): string {
  const entries = Object.entries(proof ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${label(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
}

export function ConsentHistoryTable({
  records,
  purposes,
}: {
  records: ConsentRecord[];
  /** The purposes read the host screen already performed; never an extra read. */
  purposes?: readonly { key: string; name: string }[];
}) {
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
        {records.map((r) => {
          // The server withholds personal proof fields without profiles:pii (#594); the table
          // shows that state and renders only the non-personal evidence it was given.
          const proof = proofText(r.proof);
          return (
            <Tr key={`${r.recordedAt}-${r.purpose}-${r.channel}-${r.status}`}>
              <Td className="font-medium text-fg">
                <PurposeName purpose={r.purpose} purposes={purposes} />
              </Td>
              <Td className="hidden md:table-cell">{r.channel ? named(r.channel, CHANNEL_LABEL) : 'Any'}</Td>
              <Td>
                <ConsentPill status={r.status} />
              </Td>
              <Td className="hidden lg:table-cell">{named(r.basis, BASIS_LABEL)}</Td>
              <Td className="whitespace-nowrap" title={formatDateTime(r.recordedAt)}>
                {formatDateTime(r.recordedAt)}
              </Td>
              <Td className="max-w-[320px]">
                <span className="block">{named(r.source, SOURCE_LABEL) || 'Not recorded'}</span>
                {proof && <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted">{proof}</span>}
                {r.proofWithheld && (
                  <span
                    className="mt-0.5 block text-[12px] text-muted"
                    title="Your role needs profiles:pii to see IP addresses, user agents and page URLs kept as consent proof, or an import's own free-text label."
                  >
                    Hidden for your role
                  </span>
                )}
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
      {other > 0 && <StatusPill tone="warn">{other} not allowed</StatusPill>}
    </span>
  );
}
