import { api, type Out } from '../../../app/api';
import { useKeyedApi } from '../../../app/useApi';
import { Alert, ListSkeleton, StatusPill, Table, TableFrame, Td, THead, Th, Tr } from '../../../ui';
import { pointsText } from '../../campaigns/phase26/model';
import type { JNode } from '../model';

// Split results (#313) with the shared k floor (#757). An arm below k is null and says so; when
// any arm is below k the server withholds every comparison, so the card never renders a hidden
// arm as zero or a verdict from a hidden baseline.
//
// Rates are percentages, but absoluteLift and both ends of ci95 are rate differences: the same
// quantity every holdout surface prints as percentage points (#916).

type SplitResult = Out<'journeys.splitResult'>;

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const cellText = (value: number | null, suppressed: boolean, format: (n: number) => string) =>
  suppressed ? 'Suppressed' : value === null ? 'Unavailable' : format(value);

const VERDICT: Record<SplitResult['comparisons'][number]['verdict'], { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  not_enough_data: { label: 'Not enough data yet', tone: 'warn' },
  no_clear_difference: { label: 'No clear difference', tone: 'neutral' },
  treatment_better: { label: 'Better', tone: 'good' },
  treatment_worse: { label: 'Worse', tone: 'bad' },
};

export function SplitResultsCard({ journeyId, node, from, to }: { journeyId: string; node: JNode; from: string; to: string }) {
  const split = useKeyedApi(`${journeyId}|${node.id}|${from}|${to}`, () =>
    api.call('journeys.splitResult', { journeyId, node: node.id, from, to }),
  );
  const result = split.data;
  const title = `Split · ${node.label || node.id}`;

  if (split.error)
    return (
      <Alert tone="bad" title="Couldn't load the split result">
        {split.error}
      </Alert>
    );
  if (!result) return split.loading ? <ListSkeleton label="Loading the split result" rows={2} columns={5} /> : null;

  const suppressed = result.suppressed;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[13px] font-semibold">{title}</p>
        <StatusPill tone={suppressed ? 'warn' : 'neutral'}>{suppressed ? 'Suppressed' : 'Measured'}</StatusPill>
      </div>
      {suppressed ? (
        <Alert tone="warn" className="mt-3" title="Suppressed">
          Arms smaller than k={result.k} are hidden. Counts, rates and comparisons are withheld; no estimate is substituted.
        </Alert>
      ) : (
        result.note && <p className="mt-2 text-[12px] text-muted">{result.note}</p>
      )}
      <div className="mt-3">
        <TableFrame columns={6} isEmpty={false}>
          <Table label="Split arms">
            <THead>
              <tr>
                <Th>Arm</Th>
                <Th align="right">Weight</Th>
                <Th align="right">Entered</Th>
                <Th align="right">Reached goal</Th>
                <Th align="right">Conversion</Th>
                <Th align="right">Unsubscribed</Th>
              </tr>
            </THead>
            <tbody>
              {result.arms.map((arm) => (
                <Tr key={arm.arm}>
                  <Td>
                    <span className="font-medium text-fg">Path {String.fromCharCode(65 + arm.arm)}</span>
                  </Td>
                  <Td align="right">{pct(arm.weight / 100)}</Td>
                  <Td align="right">{cellText(arm.entered, arm.suppressed, (n) => n.toLocaleString())}</Td>
                  <Td align="right">{cellText(arm.converted, arm.suppressed, (n) => n.toLocaleString())}</Td>
                  <Td align="right">{cellText(arm.conversionRate, arm.suppressed, pct)}</Td>
                  <Td align="right">{cellText(arm.unsubscribeRate, arm.suppressed, pct)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </div>
      {!suppressed && result.comparisons.length > 0 && (
        <div className="mt-3 space-y-1">
          {result.comparisons.map((comparison) => {
            const verdict = VERDICT[comparison.verdict];
            return (
              <p key={comparison.arm} className="text-[12px] text-fg-2">
                Path {String.fromCharCode(65 + comparison.arm)} against A: lift <strong>{pointsText(comparison.absoluteLift)}</strong>{' '}
                absolute
                {comparison.relativeLift !== null ? ` (${pct(comparison.relativeLift)} relative)` : ''}
                {comparison.ci95 ? ` · 95% CI ${pointsText(comparison.ci95[0])} to ${pointsText(comparison.ci95[1])}` : ''} ·{' '}
                <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
              </p>
            );
          })}
        </div>
      )}
      {suppressed && (
        <p className="mt-3 text-[12px] text-fg-2">
          <strong>Suppressed</strong> · the k={result.k} anonymity rule hides a small arm, so no comparison or verdict is shown.
        </p>
      )}
    </div>
  );
}
