import { api } from '../../../app/api';
import { useApi } from '../../../app/useApi';
import { Alert, Button, Card, Field, KpiTile, Select, Skeleton, Table, Td, THead, Th, Tr } from '../../../ui';
import { Identifier } from '../../../ui/Identifier';
import type { LocalDayPeriod, ReportPeriodChoice } from '../../broadcasts/period';
import { actionClassLabel } from '../labels';
import {
  type AgentReport,
  actionRows,
  type BroadcastOutcome,
  DECISION_ROWS,
  type DecisionKey,
  type DirectOutcome,
  decisionTotals,
  fetchedText,
  type GoalOutcome,
  goalTileExplanation,
  goalTileUnit,
  goalTileValue,
  intText,
  LATEST_EVENT_UNAVAILABLE,
  measureName,
  OUTCOME_METRICS,
  outcomeValue,
  reportPeriodLabel,
  returnedPeriodLabel,
} from './model';
import { useFetchedAt } from './useFetchedAt';

// The Overview tab (#509): outcomes and goals as KPI tiles, the decision breakdown by action
// class with its table fallback, and the journey outcomes the report returns. It owns exactly one
// agents.report read for the selected period; no artifact scan names a journey.

export function OverviewTab({
  agentId,
  period,
  choice,
  canAudit,
  refreshKey,
  onChoiceChange,
  onRefresh,
}: {
  agentId: string;
  period: LocalDayPeriod;
  choice: ReportPeriodChoice;
  canAudit: boolean;
  refreshKey: number;
  onChoiceChange: (choice: ReportPeriodChoice) => void;
  onRefresh: () => void;
}) {
  const report = useApi(
    () => api.call('agents.report', { agentId, from: period.from, to: period.to }),
    [agentId, period.from, period.to, refreshKey],
    { skip: !canAudit },
  );
  // The report contract has no event freshness. The fetch time is shown separately, never as the
  // latest event in the period.
  const fetchedAt = useFetchedAt(report.data);
  const busy = report.refreshing || (report.loading && !report.data);

  const toolbar = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <Field label="Period" className="w-[240px]">
        <Select value={choice} onChange={(event) => onChoiceChange(Number(event.target.value) === 30 ? 30 : 7)} aria-label="Period">
          <option value={7}>Last 7 complete days</option>
          <option value={30}>Last 30 complete days</option>
        </Select>
      </Field>
      <Button onClick={onRefresh}>Refresh</Button>
    </div>
  );

  const periodAnnouncement = (
    <p role="status" aria-live="polite" className="sr-only">
      Showing {returnedPeriodLabel(period.from, period.to)} in {period.zone}.
    </p>
  );

  if (!canAudit) {
    return (
      <div className="space-y-5">
        {toolbar}
        {periodAnnouncement}
        <Alert tone="info" title="Restricted by your role">
          The report needs audit access. No protected reads were made. Ask a workspace administrator for access.
        </Alert>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="space-y-5">
        {toolbar}
        {periodAnnouncement}
        <section aria-busy="true" aria-label="Loading agent overview" className="space-y-4">
          <p className="text-[13px] text-muted">Loading the agent report…</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {['Broadcast sent people', 'Broadcast clicked people', 'Direct messages sent', 'Goals'].map((label) => (
              <div key={label} className="rounded-lg bg-surface p-5">
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="mt-3 h-8 w-1/2" />
                <Skeleton className="mt-3 h-3 w-3/5" />
              </div>
            ))}
          </div>
          <Skeleton className="h-[220px] w-full" />
        </section>
      </div>
    );
  }

  if (report.error) {
    return (
      <div className="space-y-5">
        {toolbar}
        {periodAnnouncement}
        <Alert tone="bad" title="Couldn't load the agent report" onRetry={() => void report.reload()}>
          {report.error}
        </Alert>
      </div>
    );
  }

  const data = report.data;
  if (!data) return null;
  const outcomes = data.outcomes;
  const broadcasts: BroadcastOutcome | null = outcomes?.broadcasts ?? null;
  const direct: DirectOutcome | null = outcomes?.direct ?? null;
  const goals = outcomes?.goals ?? [];
  const journeys = outcomes?.journeys ?? [];
  const classes = actionRows(data.actions);
  const noRecordedActivity = classes.length === 0 && !broadcasts && !direct && journeys.length === 0 && goals.length === 0;

  return (
    <div className="space-y-5">
      {toolbar}
      {periodAnnouncement}
      <p className="text-[12px] leading-[18px] text-muted" role="status" aria-live="polite">
        {reportPeriodLabel(data)} · {period.zone} · {LATEST_EVENT_UNAVAILABLE} · {fetchedText(fetchedAt)}
      </p>

      {noRecordedActivity ? (
        <Alert tone="info" title="No recorded activity in this period">
          Choose another period; missing data is not a healthy result.
          {!outcomes && ' This read returned no metric layer, so outcomes stay Unavailable.'}
        </Alert>
      ) : (
        <>
          {!outcomes && (
            <Alert tone="info" title="Outcomes unavailable">
              This report returned no metric layer. This operational read has no k-suppression field; missing values remain Unavailable and
              no threshold is invented.
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {broadcasts ? (
              <>
                <KpiTile
                  label="Broadcast sent people"
                  value={broadcasts.sent}
                  unit="count"
                  explanation={
                    numberState(broadcasts.sent) === 'no-data'
                      ? 'Unavailable — the report returned no sent count.'
                      : 'Agent-published broadcasts; distinct people.'
                  }
                  dataState={numberState(broadcasts.sent)}
                />
                <KpiTile
                  label="Broadcast clicked people"
                  value={broadcasts.clicked}
                  unit="count"
                  explanation={
                    numberState(broadcasts.clicked) === 'no-data'
                      ? 'Unavailable — the report returned no clicked count.'
                      : `${intText(broadcasts.clicked)} / ${intText(broadcasts.sent)} sent people`
                  }
                  dataState={numberState(broadcasts.clicked)}
                />
              </>
            ) : (
              <KpiTile
                label="Broadcast outcomes"
                value={null}
                unit="count"
                dataState="no-data"
                explanation="Unavailable — this report returned no broadcast lane."
              />
            )}
            {direct ? (
              <KpiTile
                label="Direct messages sent"
                value={direct.sent}
                unit="count"
                explanation={
                  numberState(direct.sent) === 'no-data'
                    ? 'Unavailable — the report returned no direct-message count.'
                    : 'Separate message-count lane; never added to broadcast people.'
                }
                dataState={numberState(direct.sent)}
              />
            ) : (
              <KpiTile
                label="Direct outcomes"
                value={null}
                unit="count"
                dataState="no-data"
                explanation="Unavailable — this report returned no direct-message lane."
              />
            )}
            {goals.length === 0 ? (
              <KpiTile
                label="Goals"
                value={null}
                unit="count"
                dataState="no-data"
                explanation={outcomes ? 'No goals in the active mandate.' : 'Unavailable — this report returned no goals.'}
              />
            ) : (
              goals.map((goal) => <GoalTile key={goal.measure} goal={goal} />)
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <OutcomeLaneTable
              title="Broadcast outcomes · people"
              description="Distinct people. Never added to direct messages."
              lane={broadcasts}
            />
            <OutcomeLaneTable title="Direct outcomes · messages" description="Messages. Never added to broadcast people." lane={direct} />
          </div>

          <DecisionBreakdown actions={data.actions} />

          <Card
            title="Journey outcomes"
            description="The verdict and note the report returned for each journey. Journey names are not read here."
          >
            {journeys.length === 0 ? (
              <div className="p-4 text-[13px] text-muted">No journey outcomes in this period.</div>
            ) : (
              <ul className="divide-y divide-line">
                {journeys.map((journey) => (
                  <li key={journey.id} className="space-y-1 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">Journey</span>
                      <Identifier value={journey.id} label="Journey ID" />
                      <span className="text-[12px] text-fg-2">{journey.verdict ?? 'Verdict unavailable'}</span>
                    </div>
                    <p className="text-[12px] leading-[18px] text-muted">{journey.note || 'No note returned.'}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function numberState(value: number | null | undefined): 'populated' | 'no-data' {
  return typeof value === 'number' && Number.isFinite(value) ? 'populated' : 'no-data';
}

function GoalTile({ goal }: { goal: GoalOutcome }) {
  const value = goalTileValue(goal);
  return (
    <KpiTile
      label={`Goal · ${measureName(goal.measure)}`}
      value={value}
      unit={goalTileUnit(goal)}
      precision={goalTileUnit(goal) === '%' ? 1 : 0}
      dataState={value === null ? 'no-data' : 'populated'}
      explanation={goalTileExplanation(goal)}
    />
  );
}

function OutcomeLaneTable({
  title,
  description,
  lane,
}: {
  title: string;
  description: string;
  lane: BroadcastOutcome | DirectOutcome | null;
}) {
  return (
    <Card title={title} description={description}>
      {lane ? (
        <Table label={title}>
          <THead>
            <tr>
              <Th>Outcome</Th>
              <Th align="right">Value</Th>
            </tr>
          </THead>
          <tbody>
            {OUTCOME_METRICS.map((metric) => {
              const value = outcomeValue(lane, metric.key);
              return (
                <Tr key={metric.key}>
                  <Td>{metric.label}</Td>
                  <Td align="right" title={value === null ? 'Unavailable' : undefined}>
                    {intText(value)}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <div className="p-4 text-[13px] text-muted">Unavailable — this report returned no lane.</div>
      )}
      <p className="px-4 pb-3 text-[12px] leading-[18px] text-muted">— means Unavailable.</p>
    </Card>
  );
}

function DecisionBreakdown({ actions }: { actions: AgentReport['actions'] }) {
  const totals = decisionTotals(actions);
  const rows = actionRows(actions);
  const max = Math.max(...DECISION_ROWS.map((row) => totals[row.key]), 0);
  const total = DECISION_ROWS.reduce((sum, row) => sum + totals[row.key], 0);

  return (
    <Card
      title="Decisions by action class"
      description="Action rows, not unique people. Counts are returned by the report; failed is its own category, never inferred from a ledger page."
    >
      <div className="space-y-5 p-4">
        {rows.length === 0 ? (
          <p className="text-[13px] text-muted">No decisions recorded in this period.</p>
        ) : (
          <figure aria-label="Decision counts by action class" className="space-y-5">
            <figcaption className="sr-only">
              Decision counts by action class: action rows, not people, with a table of the same returned values.
            </figcaption>
            <div className="space-y-2">
              {DECISION_ROWS.map((row) => {
                const value = totals[row.key];
                return (
                  <div key={row.key}>
                    <div className="flex items-baseline justify-between gap-3 text-[12px] leading-[18px]">
                      <span className="text-fg-2">{row.label}</span>
                      <span className="num text-fg">{value.toLocaleString('en-US')}</span>
                    </div>
                    <div
                      className="mt-1 h-2 rounded-sm bg-surface-2"
                      role="img"
                      aria-label={`${row.label}: ${value.toLocaleString('en-US')} action rows`}
                    >
                      <div className="h-2 rounded-sm bg-viz-1" style={{ width: max > 0 ? `${(value / max) * 100}%` : '0%' }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[12px] leading-[18px] text-muted">
              {total.toLocaleString('en-US')} action rows in this period. The bars share one count scale; they are not a percentage split
              and not a count of people.
            </p>
            <div className="overflow-x-auto">
              <Table label="Decisions by action class">
                <THead>
                  <tr>
                    <Th>Action class</Th>
                    {DECISION_ROWS.map((row) => (
                      <Th key={row.key} align="right">
                        {row.label}
                      </Th>
                    ))}
                  </tr>
                </THead>
                <tbody>
                  {rows.map(({ actionClass, counts }) => (
                    <Tr key={actionClass}>
                      <Td>{actionClassLabel(actionClass)}</Td>
                      {DECISION_ROWS.map((row) => (
                        <Td key={row.key} align="right">
                          {counts[row.key as DecisionKey].toLocaleString('en-US')}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </figure>
        )}
      </div>
    </Card>
  );
}
