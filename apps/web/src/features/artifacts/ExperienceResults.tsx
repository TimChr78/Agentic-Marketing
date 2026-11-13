import { RefreshCw } from 'lucide-react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, EmptyState, ListSkeleton, Table, TableFrame, Tag, Td, THead, Th, Tr } from '../../ui';
import type { Artifact } from './ArtifactDetailPage';

// Experiment results of a web experience: exposures, conversions and rates per variant, compared
// with the control (the holdout, or else the first variant), with the significance measure the
// experience's analysis method calls for. Exposures and conversions are counted by the events
// service; previews are not counted.

const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
const points = (n: number) => `${(n * 100).toFixed(1)} points`;

const METHOD_TEXT: Record<'sequential' | 'bayesian' | 'fixed', (alpha: string | null, threshold: string | null) => string> = {
  sequential: (alpha) =>
    `Sequential analysis: the always-valid p-value can be read at any time without raising the false-positive rate. A variant is recommended when its p-value for the goal event falls below ${alpha ?? 'the configured alpha'}.`,
  bayesian: (_, threshold) =>
    `Bayesian analysis: each variant gets a probability of beating the control. A variant is recommended when that probability reaches ${threshold ?? 'the configured threshold'}.`,
  fixed: () =>
    'Fixed-horizon analysis: read the p-values once the planned sample size is reached, not before. No winner is called automatically at another time.',
};

export function ExperienceResults({ artifact }: { artifact: Artifact }) {
  const published = artifact.publishedVersion !== null;
  const results = useApi(() => api.call('experiences.results', { artifactId: artifact.id }), [artifact.id], { skip: !published });
  if (!published)
    return (
      <EmptyState title="No results yet">
        Publish the experience to start collecting exposures and conversions. Results appear here as visitors see the variants.
      </EmptyState>
    );
  if (results.loading) return <ListSkeleton label="Loading experience results" columns={5} />;
  if (results.error || !results.data)
    return (
      <Alert tone="bad" title="Couldn't load the results" onRetry={results.reload}>
        {results.error ?? 'The server returned no results.'}
      </Alert>
    );

  const r = results.data;
  // The server says which version it measured and the analysis that version configured (#759);
  // the artifact row may be a newer draft with different variants, alpha and threshold.
  const alpha = r.analysis.alpha.toString();
  const threshold = `${(r.analysis.threshold * 100).toFixed(0)}%`;
  const method = r.method;
  const viewingOther = artifact.version.number !== r.version;
  const significance = method === 'bayesian' ? 'P(beats control)' : method === 'sequential' ? 'Always-valid p' : 'p-value';
  const exposures = r.variants.reduce((sum, variant) => sum + (variant.exposed ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tag>{method === 'bayesian' ? 'Bayesian' : method === 'sequential' ? 'Sequential' : 'Fixed horizon'}</Tag>
        {r.suppressed && <Tag>k={r.k} suppressed</Tag>}
        <span className="text-[12px] text-muted">
          Goal: {r.goal ?? 'none'} · Control: {r.control ?? 'none'} · results use v{r.version}
          {viewingOther && ` · you are viewing v${artifact.version.number}`}
        </span>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={results.reload} className="ml-auto">
          Refresh
        </Button>
      </div>
      <p className="text-[12px] leading-[18px] text-muted">
        Current totals for exposed visitors. Period and freshness unavailable: the results do not name a calendar period.
      </p>
      {r.suppressed && (
        <Alert tone="warn" title="Some results are suppressed">
          Fewer than k={r.k} visitors were exposed to a variant, so its counts, rates and every comparison that needs it are hidden.
        </Alert>
      )}
      {!r.goal && <Alert tone="info">Set a goal to measure conversions.</Alert>}
      {!r.control && <Alert tone="info">No control group is configured. Comparison is unavailable.</Alert>}
      {exposures === 0 && !r.suppressed && (
        <Alert tone="info" title="No exposures for this version yet">
          No visitor has been exposed to v{r.version} in this view. Events arrive within a minute or two after a visitor sees it.
        </Alert>
      )}

      <TableFrame
        isEmpty={!r.variants.length}
        empty={
          <EmptyState title="No exposures yet" compact>
            When visitors see a variant, its exposures show here. Events arrive within a minute or two.
          </EmptyState>
        }
      >
        <Table label="Experiment results">
          <THead>
            <tr>
              <Th>Variant</Th>
              <Th align="right">Exposed</Th>
              <Th align="right">Converted</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Lift vs control</Th>
              <Th align="right">95% interval</Th>
              <Th align="right">{significance}</Th>
              <Th align="right" className="hidden lg:table-cell">
                P(best)
              </Th>
            </tr>
          </THead>
          <tbody>
            {r.variants.map((v) => {
              const isControl = v.variant === r.control;
              const hidden = v.suppressed;
              return (
                <Tr key={v.variant}>
                  <Td>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {v.variant}
                      {isControl && <Tag>control</Tag>}
                      {hidden && <Tag>suppressed</Tag>}
                    </span>
                  </Td>
                  <Td align="right">{hidden ? 'Suppressed' : (v.exposed?.toLocaleString() ?? '—')}</Td>
                  <Td align="right">{hidden ? 'Suppressed' : (v.converted?.toLocaleString() ?? '—')}</Td>
                  <Td align="right">{hidden ? 'Suppressed' : pct(v.rate)}</Td>
                  <Td align="right">
                    {hidden || isControl ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span
                        className={v.lift !== null && v.lift > 0 ? 'text-good' : v.lift !== null && v.lift < 0 ? 'text-bad' : undefined}
                      >
                        {pct(v.lift)}
                      </span>
                    )}
                  </Td>
                  <Td align="right">{hidden || isControl || !v.ci95 ? '—' : `${points(v.ci95[0])} to ${points(v.ci95[1])}`}</Td>
                  <Td align="right">
                    {hidden || isControl
                      ? '—'
                      : method === 'bayesian'
                        ? pct(v.probBeatControl)
                        : method === 'sequential'
                          ? (v.sequentialP?.toFixed(3) ?? '—')
                          : (v.pValue?.toFixed(3) ?? '—')}
                  </Td>
                  <Td
                    align="right"
                    className="hidden lg:table-cell"
                    title={
                      v.expectedLoss === null
                        ? 'Expected loss is unavailable while a variant is suppressed'
                        : `Expected loss from choosing this variant: ${points(v.expectedLoss)}`
                    }
                  >
                    {pct(v.probBest)}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableFrame>

      <Alert tone="info" title="What the numbers mean">
        <p>{METHOD_TEXT[method](alpha, threshold)}</p>
        <p className="mt-1">
          {r.recommendation} {r.note}
        </p>
        {r.variants.some((v) => v.ci95) && (
          <p className="mt-1">
            The 95% interval is for the difference in conversion rate against the control, in percentage points. It is shown in its own
            column, not only on hover.
          </p>
        )}
      </Alert>
    </div>
  );
}
