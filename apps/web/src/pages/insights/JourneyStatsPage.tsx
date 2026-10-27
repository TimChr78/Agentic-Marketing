import { ExternalLink, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { HoldoutCard } from '../../features/insights/HoldoutCard';
import { StatCard, StatGrid } from '../../features/insights/Stats';
import { Alert, EmptyState, Field, LoadingBlock, Mono, PageHeader, Select, Table, TableFrame, Tag, Td, Th, THead, Tr } from '../../ui';
import { pageWidth } from '../../ui/layout';

type Node = { id: string; label?: string; kind?: string };

/** People in a journey right now, and how many reached every step. */
export default function JourneyStatsPage() {
  useCrumbs([{ label: 'Journey stats' }]);
  const { can } = useSession();
  const [selected, setSelected] = useState('');

  const journeys = useApi(() => api.call('artifacts.list', { type: 'journey' as never, limit: 200 }), []);
  useEffect(() => {
    if (!selected && journeys.data?.artifacts.length) setSelected(journeys.data.artifacts[0].id);
  }, [journeys.data, selected]);

  const stats = useApi(() => api.call('journeys.stats', { artifactId: selected }), [selected], { skip: !selected });
  const artifact = useApi(() => api.call('artifacts.get', { artifactId: selected }), [selected], { skip: !selected });
  const hasControl =
    artifact.data?.version.state === 'published' &&
    !!((artifact.data.version.content as { controlGroup?: unknown } | undefined)?.controlGroup);
  const holdout = useApi(() => api.call('journeys.holdoutResult', { journeyId: selected }), [selected], { skip: !selected || !hasControl });

  const nodes = ((artifact.data?.version.content as { nodes?: Node[] } | undefined)?.nodes ?? []).filter(Boolean);
  const s = stats.data;
  const nodeIds = s ? Array.from(new Set([...Object.keys(s.reached), ...Object.keys(s.waitingAt)])) : [];
  const nodeRows = nodeIds
    .map((id) => ({
      id,
      node: nodes.find((n) => n.id === id),
      reached: s?.reached[id] ?? 0,
      waiting: s?.waitingAt[id] ?? 0,
    }))
    .sort((a, b) => {
      const ai = nodes.findIndex((n) => n.id === a.id);
      const bi = nodes.findIndex((n) => n.id === b.id);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.id.localeCompare(b.id);
    });

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Journey stats"
        description="How many people are at each step of a journey right now, and how many passed it."
        actions={
          selected && (
            <ButtonLink to={`/build/journeys/${selected}`} icon={<ExternalLink size={15} />}>
              Open in builder
            </ButtonLink>
          )
        }
      />

      {journeys.loading ? (
        <LoadingBlock lines={5} label="Loading journeys" />
      ) : journeys.error ? (
        <Alert tone="bad" title="Couldn't load journeys" onRetry={journeys.reload}>
          {journeys.error}
        </Alert>
      ) : (journeys.data?.artifacts.length ?? 0) === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            icon={<Workflow size={16} />}
            title="No journeys yet"
            action={can('artifacts:write') && <ButtonLink to="/build/journeys" variant="primary">Create a journey</ButtonLink>}
          >
            Build a journey from a trigger to a goal, publish it, and its participants appear here.
          </EmptyState>
        </div>
      ) : (
        <div className="space-y-5">
          <Field label="Journey" className="max-w-[380px]">
            <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {(journeys.data?.artifacts ?? []).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                  {j.publishedVersion ? ` · live v${j.publishedVersion}` : ` · ${j.latestState.replace(/_/g, ' ')}`}
                </option>
              ))}
            </Select>
          </Field>

          {stats.loading ? (
            <LoadingBlock lines={6} label="Loading journey stats" />
          ) : stats.error ? (
            <Alert tone="bad" title="Couldn't load the stats" onRetry={stats.reload}>
              {stats.error}
            </Alert>
          ) : s ? (
            <>
              <StatGrid>
                <StatCard label="Ready" value={s.now.ready.toLocaleString()} hint="Waiting to start" />
                <StatCard label="Waiting" value={s.now.waiting.toLocaleString()} hint="At a step now" />
                <StatCard label="Completed" value={s.now.completed.toLocaleString()} />
                <StatCard label="Exited" value={s.now.exited.toLocaleString()} />
                <StatCard label="Failed" value={s.now.failed.toLocaleString()} tone={s.now.failed > 0 ? 'bad' : undefined} />
                <StatCard label="Converted" value={s.now.converted.toLocaleString()} tone={s.now.converted > 0 ? 'good' : undefined} />
              </StatGrid>

              {hasControl && <HoldoutCard result={holdout.data} loading={holdout.loading} error={holdout.error ?? undefined} />}

              <TableFrame
                columns={3}
                isEmpty={nodeRows.length === 0}
                empty={
                  <EmptyState compact title="No one has entered this journey yet">
                    Once it is live and someone matches the trigger, the steps show who reached them.
                  </EmptyState>
                }
              >
                <Table label="Journey steps">
                  <THead>
                    <tr>
                      <Th>Step</Th>
                      <Th align="right">Reached</Th>
                      <Th align="right">Waiting now</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {nodeRows.map((r) => (
                      <Tr key={r.id}>
                        <Td>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-fg">{r.node?.label || r.id}</span>
                            {r.node?.kind && <Tag>{r.node.kind}</Tag>}
                            <Mono className="bg-transparent px-0 text-muted">{r.id}</Mono>
                          </span>
                        </Td>
                        <Td align="right">{r.reached.toLocaleString()}</Td>
                        <Td align="right">{r.waiting.toLocaleString()}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableFrame>
              <p className="text-[12px] text-muted">
                Counted from the journey's participants and step events. “Converted” is how many reached the goal, also included in completed or exited.
              </p>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
