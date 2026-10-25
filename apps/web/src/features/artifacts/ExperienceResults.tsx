import { RefreshCw } from 'lucide-react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, EmptyState, LoadingBlock, Table, TableFrame, Tag, Td, Th, THead, Tr } from '../../ui';
import type { Artifact } from './ArtifactDetailPage';

// Experiment results of a web experience: exposures, conversions and rates per variant, compared
// with the control (the holdout, or else the first variant), with the significance measure the
// experience's analysis method calls for. Exposures and conversions are counted by the events
// service; previews are not counted.

interface Analysis {
  method?: 'sequential' | 'bayesian' | 'fixed';
  alpha?: number;
  threshold?: number;
}

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
  if (results.loading) return <LoadingBlock lines={5} />;
  if (results.error || !results.data)
    return (
      <Alert tone="bad" title="Couldn't load the results" onRetry={results.reload}>
        {results.error ?? 'The server returned no results.'}
      </Alert>
    );

  const r = results.data;
  const viewingLatest = artifact.version.number === artifact.latestVersion;
  const analysis = viewingLatest ? (artifact.version.content as { analysis?: Analysis } | null)?.analysis : undefined;
  const alpha = viewingLatest ? (analysis?.alpha ?? 0.05).toString() : null;
  const threshold = viewingLatest ? `${((analysis?.threshold ?? 0.95) * 100).toFixed(0)}%` : null;
  const method = r.method;
  const significance = method === 'bayesian' ? 'P(beats control)' : method === 'sequential' ? 'Always-valid p' : 'p-value';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tag>{method === 'bayesian' ? 'Bayesian' : method === 'sequential' ? 'Sequential' : 'Fixed horizon'}</Tag>
        <span className="text-[12px] text-muted">
          Goal: {r.goal ?? 'none'} · Control: {r.control ?? 'none'}
          {!viewingLatest && ` · results use v${artifact.latestVersion}`}
        </span>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={results.reload} className="ml-auto">
          Refresh
        </Button>
      </div>

      <TableFrame
        isEmpty={!r.variants.length}
        empty={<EmptyState title="No exposures yet" compact>When visitors see a variant, its exposures show here. Events arrive within a minute or two.</EmptyState>}
      >
        <Table label="Experiment results">
          <THead>
            <tr>
              <Th>Variant</Th>
              <Th align="right">Exposed</Th>
              <Th align="right">Converted</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Lift vs control</Th>
              <Th align="right">{significance}</Th>
              <Th align="right" className="hidden lg:table-cell">
                P(best)
              </Th>
            </tr>
          </THead>
          <tbody>
            {r.variants.map((v) => {
              const isControl = v.variant === r.control;
              return (
                <Tr key={v.variant}>
                  <Td>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {v.variant}
                      {isControl && <Tag>control</Tag>}
                    </span>
                  </Td>
                  <Td align="right">{v.exposed.toLocaleString()}</Td>
                  <Td align="right">{v.converted.toLocaleString()}</Td>
                  <Td align="right">{pct(v.rate)}</Td>
                  <Td align="right" title={v.ci95 ? `95% interval for the difference in rate: ${points(v.ci95[0])} to ${points(v.ci95[1])}` : undefined}>
                    {isControl ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={v.lift !== null && v.lift > 0 ? 'text-good' : v.lift !== null && v.lift < 0 ? 'text-bad' : undefined}>{pct(v.lift)}</span>
                    )}
                  </Td>
                  <Td align="right">
                    {isControl
                      ? '—'
                      : method === 'bayesian'
                        ? pct(v.probBeatControl)
                        : method === 'sequential'
                          ? (v.sequentialP?.toFixed(3) ?? '—')
                          : (v.pValue?.toFixed(3) ?? '—')}
                  </Td>
                  <Td align="right" className="hidden lg:table-cell" title={`Expected loss from choosing this variant: ${points(v.expectedLoss)}`}>
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
          <p className="mt-1">The 95% interval is for the difference in conversion rate, in percentage points; hover a lift to read it.</p>
        )}
      </Alert>
    </div>
  );
}
