import { Alert, LoadingBlock, StatusPill, Table, TableFrame, Td, THead, Th, Tr } from '../../ui';

// Treatment against control, with the interval and the guardrail (#67). Shared by the journey
// stats page and the campaign evaluation card so both say the same thing about a holdout.

export type HoldoutArm = {
  entered: number;
  converted: number;
  unsubscribed: number;
  conversionRate: number;
  unsubscribeRate: number;
  revenue?: Record<string, number>;
};

export type HoldoutResult = {
  controlGroup: { percent: number; minSampleSize: number; hashVersion: string };
  control: HoldoutArm;
  treatment: HoldoutArm;
  absoluteLift: number;
  relativeLift: number | null;
  ci95: [number, number] | null;
  minSampleSizeMet: boolean;
  verdict: 'not_enough_data' | 'no_clear_difference' | 'treatment_better' | 'treatment_worse';
  note: string;
};

const VERDICT: Record<HoldoutResult['verdict'], { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  not_enough_data: { label: 'Not enough data yet', tone: 'warn' },
  no_clear_difference: { label: 'No clear difference', tone: 'neutral' },
  treatment_better: { label: 'Treatment better', tone: 'good' },
  treatment_worse: { label: 'Treatment worse', tone: 'bad' },
};

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toLocaleString('en')} ${currency}`;
  }
};

export function HoldoutCard({
  result,
  loading,
  error,
  title = 'Holdout result',
}: {
  result?: HoldoutResult | null;
  loading?: boolean;
  error?: string;
  title?: string;
}) {
  if (error)
    return (
      <Alert tone="bad" title="Couldn't load the holdout result">
        {error}
      </Alert>
    );
  if (!result) return loading ? <LoadingBlock lines={4} label="Loading the holdout result" /> : null;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const v = VERDICT[result.verdict];
  const arms = [
    { label: 'Control', ...result.control },
    { label: 'Treatment', ...result.treatment },
  ];
  const currencies = [...new Set(arms.flatMap((a) => Object.keys(a.revenue ?? {})))];
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold">{title}</p>
          <p className="text-[12px] text-muted">
            {result.controlGroup.percent}% control, at least {result.controlGroup.minSampleSize} per arm
          </p>
        </div>
        <StatusPill tone={v.tone}>{v.label}</StatusPill>
      </div>
      {result.verdict === 'not_enough_data' && (
        <Alert tone="info" className="mt-3" title="Not enough data yet">
          {result.note}
        </Alert>
      )}
      <div className="mt-3">
        <TableFrame columns={currencies.length ? 6 : 5} isEmpty={false}>
          <Table label="Holdout arms">
            <THead>
              <tr>
                <Th>Arm</Th>
                <Th align="right">Assigned</Th>
                <Th align="right">Reached goal</Th>
                <Th align="right">Conversion</Th>
                <Th align="right">Unsubscribed</Th>
                {currencies.length > 0 && <Th align="right">Revenue</Th>}
              </tr>
            </THead>
            <tbody>
              {arms.map((a) => (
                <Tr key={a.label}>
                  <Td>
                    <span className="font-medium text-fg">{a.label}</span>
                  </Td>
                  <Td align="right">{a.entered.toLocaleString()}</Td>
                  <Td align="right">{a.converted.toLocaleString()}</Td>
                  <Td align="right">{pct(a.conversionRate)}</Td>
                  <Td align="right">{pct(a.unsubscribeRate)}</Td>
                  {currencies.length > 0 && <Td align="right">{currencies.map((c) => money(a.revenue?.[c] ?? 0, c)).join(' · ')}</Td>}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </div>
      <p className="mt-3 text-[12px] text-fg-2">
        Lift: <strong>{pct(result.absoluteLift)}</strong> absolute
        {result.relativeLift !== null ? ` (${pct(result.relativeLift)} relative)` : ''}
        {result.ci95 ? ` · 95% CI ${pct(result.ci95[0])} to ${pct(result.ci95[1])}` : ''}
      </p>
      <p className="mt-1 text-[12px] text-muted">
        Difference of conversion rates, Newcombe's interval. Unsubscribes are the e-mail guardrail; control gets no e-mail, so its rate is
        expected to be zero. {result.verdict !== 'not_enough_data' ? result.note : ''}
      </p>
    </div>
  );
}
