import { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../../../app/api';
import { useApi } from '../../../app/useApi';
import { Alert, Button, Card, Checkbox, EmptyState, Select, Skeleton, Table, Td, THead, Th, Tr } from '../../../ui';
import { type ReportPeriodChoice, reportPeriod } from '../../broadcasts/period';
import type { Agent } from '../labels';
import {
  type AgentComparison,
  agentStatusText,
  type BroadcastOutcome,
  type ComparisonAgent as ComparedAgent,
  comparisonPeriodLabel,
  costText,
  type DirectOutcome,
  fetchedText,
  goalsText,
  intText,
  OUTCOME_METRICS,
  type OutcomeMetricKey,
  outcomeValue,
  zoneOf,
} from './model';
import { useFetchedAt } from './useFetchedAt';

// The comparison (#509) on the agents list: small multiples for an explicit 1–20 agent selection,
// one agents.compare read on opening or Apply, and no per-agent report/mandate reads. Each metric
// has the same scale across the selected agents; broadcast people and direct messages stay in
// separate lanes and are never added.

export function ComparisonSection({ agents, canAudit }: { agents: Agent[]; canAudit: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [applied, setApplied] = useState<string[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [choice, setChoice] = useState<ReportPeriodChoice>(7);
  const [anchor, setAnchor] = useState(() => new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  const period = useMemo(() => reportPeriod(choice, anchor), [choice, anchor]);

  // The first opening compares the first 20 listed agents. That is a bounded, explicit id list, not
  // an implicit “all agents” request, and every later change waits for Apply.
  useEffect(() => {
    if (initialized || agents.length === 0) return;
    const ids = agents.slice(0, 20).map((agent) => agent.id);
    setSelected(ids);
    setApplied(ids);
    setInitialized(true);
  }, [agents, initialized]);

  const appliedKey = applied.join(',');
  const compare = useApi(
    () => api.call('agents.compare', { agentIds: applied, from: period.from, to: period.to }),
    [appliedKey, period.from, period.to, refreshKey],
    { skip: !canAudit || applied.length === 0 },
  );
  const fetchedAt = useFetchedAt(compare.data);
  const comparisonBusy = compare.refreshing || (compare.loading && !compare.data);

  if (!canAudit) {
    return (
      <Card title="Comparison" description="Side by side for the same period, from one bounded read.">
        <div className="p-4">
          <Alert tone="info" title="Restricted by your role">
            The comparison needs audit access. No protected reads were made. Ask a workspace administrator for access.
          </Alert>
        </div>
      </Card>
    );
  }

  if (agents.length === 0) {
    return (
      <Card title="Comparison" description="Side by side for the same period, from one bounded read.">
        <EmptyState compact title="No agents to compare yet">
          An agent appears here once it has a credential.
        </EmptyState>
      </Card>
    );
  }

  const toggle = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= 20) return current;
      return [...current, id];
    });
  };

  const apply = () => {
    if (selected.length === 0) return;
    setAnchor(new Date());
    setApplied(selected);
    setRefreshKey((value) => value + 1);
  };

  return (
    <Card
      title="Comparison"
      description="Totals for the selected period. Choose up to 20 agents to compare side by side."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            compact
            className="w-auto"
            aria-label="Comparison period"
            value={choice}
            onChange={(event) => {
              setAnchor(new Date());
              setChoice(Number(event.target.value) === 30 ? 30 : 7);
              setRefreshKey((value) => value + 1);
            }}
          >
            <option value={7}>Last 7 complete days</option>
            <option value={30}>Last 30 complete days</option>
          </Select>
          <Button
            onClick={() => {
              setAnchor(new Date());
              setRefreshKey((value) => value + 1);
            }}
          >
            Refresh comparison
          </Button>
        </div>
      }
    >
      <div className="border-b border-line px-4 py-3">
        <details>
          <summary className="flex min-h-10 cursor-pointer items-center text-[12px] font-medium text-accent">
            Choose agents ({selected.length}/20)
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => {
              const checked = selected.includes(agent.id);
              return (
                <Checkbox
                  key={agent.id}
                  label={agent.name}
                  checked={checked}
                  disabled={!checked && selected.length >= 20}
                  onChange={() => toggle(agent.id)}
                />
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={selected.length === 0} onClick={apply}>
              Apply
            </Button>
            <span className="text-[12px] text-muted">
              {selected.length === 0 ? 'Select at least one agent.' : `${selected.length} selected.`}
            </span>
          </div>
          {agents.length > 20 && (
            <p className="mt-2 text-[12px] text-muted">
              Only the first 20 agents are selected by default. Choose others explicitly; a comparison holds at most 20.
            </p>
          )}
        </details>
      </div>

      {applied.length === 0 ? (
        <EmptyState compact title="Choose agents to compare">
          Select between 1 and 20 agents, then Apply. The comparison reads once for that selection.
        </EmptyState>
      ) : comparisonBusy ? (
        <section aria-busy="true" aria-label="Loading the agent comparison" className="space-y-3 p-4">
          <Skeleton className="h-3 w-1/3" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </section>
      ) : compare.error ? (
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load the comparison" onRetry={() => void compare.reload()}>
            {compare.error}
          </Alert>
        </div>
      ) : compare.data ? (
        <ComparisonBody data={compare.data} fetchedAt={fetchedAt} selectedCount={applied.length} totalAgents={agents.length} />
      ) : null}
    </Card>
  );
}

const broadcastKeys: OutcomeMetricKey[] = OUTCOME_METRICS.map((metric) => metric.key);

function maxima(agents: ComparedAgent[], lane: 'broadcasts' | 'direct'): Record<OutcomeMetricKey, number> {
  const out = {} as Record<OutcomeMetricKey, number>;
  for (const metric of OUTCOME_METRICS) {
    const values = agents.map((agent) => {
      const laneValue = agent.outcomes?.[lane] ?? null;
      return outcomeValue(laneValue, metric.key);
    });
    out[metric.key] = Math.max(...values.filter((value): value is number => typeof value === 'number'), 0);
  }
  return out;
}

function ComparisonBody({
  data,
  fetchedAt,
  selectedCount,
  totalAgents,
}: {
  data: AgentComparison;
  fetchedAt: Date | null;
  selectedCount: number;
  totalAgents: number;
}) {
  const agents = data.agents;
  const broadcastMax = maxima(agents, 'broadcasts');
  const directMax = maxima(agents, 'direct');

  return (
    <div className="space-y-4 p-4">
      <p className="text-[12px] leading-[18px] text-muted" role="status" aria-live="polite">
        {comparisonPeriodLabel(data)} · {zoneOf()} · Period totals, not trends or a ranking · {fetchedText(fetchedAt)}
      </p>
      {data.truncated && (
        <Alert tone="info" title="More agents had activity">
          This comparison includes {intText(agents.length)} agents. Compare explicit ids to see others.
        </Alert>
      )}
      {totalAgents > 20 && !data.truncated && (
        <p className="text-[12px] leading-[18px] text-muted">
          You selected {selectedCount} of {totalAgents} agents. A comparison holds at most 20; choose another selection to see others.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {agents.map((agent) => (
          <SmallMultipleCard key={agent.agentId} agent={agent} broadcastMax={broadcastMax} directMax={directMax} />
        ))}
      </div>

      <p className="text-[12px] leading-[18px] text-muted">
        Same scale per metric across these agents. Broadcast values are distinct people; direct values are messages. They are never added.
        Goals without a measured value stay unknown, not unmet.
      </p>

      <ComparisonTable agents={agents} />
    </div>
  );
}

function SmallMultipleCard({
  agent,
  broadcastMax,
  directMax,
}: {
  agent: ComparedAgent;
  broadcastMax: Record<OutcomeMetricKey, number>;
  directMax: Record<OutcomeMetricKey, number>;
}) {
  const id = useId().replace(/:/g, '');
  const broadcast = agent.outcomes?.broadcasts ?? null;
  const direct = agent.outcomes?.direct ?? null;
  return (
    <article aria-labelledby={id} className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <h3 id={id} className="text-[15px] leading-5 font-semibold">
        {agent.name}
      </h3>
      <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
        {agentStatusText(agent.status)}
        {agent.mandates.length > 0 &&
          ` · ${agent.mandates
            .filter((mandate) => mandate.mandateId)
            .map((mandate) => `v${mandate.version}`)
            .join(', ')}`}
      </p>

      <div className="mt-4 space-y-4">
        <MetricLane
          title="Broadcast outcomes · people"
          lane="broadcasts"
          agent={agent}
          values={broadcast}
          max={broadcastMax}
          unit="people"
        />
        <MetricLane title="Direct outcomes · messages" lane="direct" agent={agent} values={direct} max={directMax} unit="messages" />
        <div className="border-t border-line pt-3 text-[12px] leading-[18px]">
          <p className="text-fg-2">Goals: {goalsText(agent)}</p>
          <p className="mt-0.5 text-muted">
            AI: {agent.ai.calls > 0 ? `${intText(agent.ai.calls)} calls` : 'No calls'} · {costText(agent.ai.cost)}
          </p>
        </div>
      </div>
    </article>
  );
}

function MetricLane({
  title,
  lane,
  agent,
  values,
  max,
  unit,
}: {
  title: string;
  lane: 'broadcasts' | 'direct';
  agent: ComparedAgent;
  values: BroadcastOutcome | DirectOutcome | null;
  max: Record<OutcomeMetricKey, number>;
  unit: string;
}) {
  return (
    <div>
      <p className="text-[12px] font-medium text-fg-2">{title}</p>
      {!values ? (
        <p className="mt-1 text-[12px] text-muted">
          Unavailable —{' '}
          {lane === 'broadcasts'
            ? 'no broadcast results for this agent in the period'
            : 'no direct-message results for this agent in the period'}
          .
        </p>
      ) : (
        <div className="mt-1 space-y-1.5">
          {OUTCOME_METRICS.map((metric) => {
            const value = outcomeValue(values, metric.key);
            const width = value !== null && max[metric.key] > 0 ? (value / max[metric.key]) * 100 : 0;
            const valueText = value === null ? 'Unavailable' : `${intText(value)} ${unit}`;
            return (
              <div key={metric.key}>
                <div className="flex items-baseline justify-between gap-3 text-[12px] leading-[18px]">
                  <span className="text-muted">{metric.label}</span>
                  <span className="num text-fg-2">{value === null ? '—' : intText(value)}</span>
                </div>
                <div
                  className="mt-0.5 h-1.5 rounded-sm bg-surface-2"
                  role="img"
                  aria-label={`${agent.name} · ${metric.label}: ${valueText}`}
                >
                  <div className="h-1.5 rounded-sm bg-viz-2" style={{ width: `${width}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ComparisonTable({ agents }: { agents: ComparedAgent[] }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable table must be reachable by keyboard (axe scrollable-region-focusable).
    <section className="overflow-x-auto rounded-lg border border-line" aria-label="Agent comparison values, scrollable" tabIndex={0}>
      <Table label="Agent comparison values">
        <THead>
          <tr>
            <Th>Agent</Th>
            {OUTCOME_METRICS.map((metric) => (
              <Th key={`b-${metric.key}`} align="right">
                Broadcast {metric.label.toLowerCase()} (people)
              </Th>
            ))}
            {OUTCOME_METRICS.map((metric) => (
              <Th key={`d-${metric.key}`} align="right">
                Direct {metric.label.toLowerCase()} (messages)
              </Th>
            ))}
            <Th>Goals</Th>
            <Th align="right">AI calls</Th>
            <Th align="right">AI cost</Th>
          </tr>
        </THead>
        <tbody>
          {agents.map((agent) => (
            <Tr key={agent.agentId}>
              <Td>{agent.name}</Td>
              {broadcastKeys.map((key) => (
                <Td
                  key={`b-${key}`}
                  align="right"
                  title={outcomeValue(agent.outcomes?.broadcasts ?? null, key) === null ? 'Unavailable' : undefined}
                >
                  {intText(outcomeValue(agent.outcomes?.broadcasts ?? null, key))}
                </Td>
              ))}
              {broadcastKeys.map((key) => (
                <Td
                  key={`d-${key}`}
                  align="right"
                  title={outcomeValue(agent.outcomes?.direct ?? null, key) === null ? 'Unavailable' : undefined}
                >
                  {intText(outcomeValue(agent.outcomes?.direct ?? null, key))}
                </Td>
              ))}
              <Td>{goalsText(agent)}</Td>
              <Td align="right">{intText(agent.ai.calls)}</Td>
              <Td align="right" title={agent.ai.cost === null ? 'Unavailable' : undefined}>
                {costText(agent.ai.cost)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

// Re-exported for tests that want the comparison row type without reaching into app/api.
export type ComparisonRow = ComparedAgent;
