import { useState } from 'react';
import type { Out } from '../../app/api';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Card, EmptyState, Select, Table, TableFrame, Td, THead, Th, Tr } from '../../ui';
import { ACTION_CLASS_LABEL, AGENT_STATUS } from './labels';

type Comparison = Out<'agents.compare'>['agents'][number];

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');
const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);

/** Actions, holds and outcomes for one agent, summed across its mandate versions. */
function tally(a: Comparison) {
  const out = { allow: 0, hold: 0, ask: 0, deny: 0, failed: 0, undone: 0, rejected: 0, ran: 0, pending: 0 };
  for (const m of a.mandates) {
    for (const c of Object.values(m.actions)) {
      out.allow += c.allow;
      out.hold += c.hold;
      out.ask += c.ask;
      out.deny += c.deny;
      out.failed += c.failed;
    }
    out.undone += m.undone;
    out.rejected += m.holds.rejected;
    out.ran += m.holds.ran;
    out.pending += m.holds.pending;
  }
  return out;
}

/** Agent comparison side by side (#428): what each agent did and what it led to in one period. */
export function CompareAgentsCard() {
  const [days, setDays] = useState(30);
  const compare = useApi(
    () =>
      api.call('agents.compare', {
        from: new Date(Date.now() - days * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      }),
    [days],
  );
  const agents = compare.data?.agents ?? [];

  return (
    <Card
      title="Compare agents"
      description="Actions, holds and results side by side for the same period, with each mandate version they acted under."
      action={
        <Select compact className="w-auto" aria-label="Comparison period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {PERIODS.map((p) => (
            <option key={p.days} value={p.days}>
              {p.label}
            </option>
          ))}
        </Select>
      }
    >
      <TableFrame
        className="rounded-none border-0"
        loading={compare.loading}
        error={compare.error}
        onRetry={compare.reload}
        columns={6}
        isEmpty={agents.length === 0}
        empty={
          <EmptyState compact title="Nothing to compare yet">
            An agent appears here once it has a credential.
          </EmptyState>
        }
      >
        <Table label="Agent comparison">
          <THead>
            <tr>
              <Th>Agent</Th>
              <Th>Actions</Th>
              <Th>Holds</Th>
              <Th>Outcomes</Th>
              <Th>Goals</Th>
              <Th>AI</Th>
            </tr>
          </THead>
          <tbody>
            {agents.map((a) => {
              const t = tally(a);
              const b = a.outcomes?.broadcasts;
              const d = a.outcomes?.direct;
              return (
                <Tr key={a.agentId}>
                  <Td>
                    <div className="font-medium text-fg">{a.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {AGENT_STATUS[a.status as keyof typeof AGENT_STATUS]?.label ?? a.status}
                      {a.mandates.length > 0 &&
                        ` · ${a.mandates
                          .filter((m) => m.mandateId)
                          .map((m) => `v${m.version}${m.active ? '' : ' (lapsed)'}`)
                          .join(', ')}`}
                    </div>
                    {a.mandates.length > 0 && (
                      <div className="mt-0.5 max-w-[220px] text-[11px] text-muted">
                        {Object.keys(a.mandates[0]?.actions ?? {})
                          .map((cls) => ACTION_CLASS_LABEL[cls] ?? cls)
                          .join(' · ')}
                      </div>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-[12px]">
                    {t.allow} ran · {t.hold} held · {t.ask} to a person · {t.deny} refused
                    {t.failed ? ` · ${t.failed} failed` : ''}
                    {t.undone ? <div className="mt-0.5 text-muted">{t.undone} undone</div> : null}
                  </Td>
                  <Td className="whitespace-nowrap text-[12px]">
                    {t.rejected} vetoed · {t.ran} ran
                    {t.pending ? <div className="mt-0.5 text-muted">{t.pending} pending</div> : null}
                  </Td>
                  <Td className="text-[12px]">
                    {b ? (
                      <div>
                        {b.count} broadcasts · {b.sent} sent · opens {pct(b.opened, b.sent)} · clicks {pct(b.clicked, b.sent)}
                        {b.unsubscribed ? ` · unsubscribes ${pct(b.unsubscribed, b.sent)}` : ''}
                      </div>
                    ) : null}
                    {d ? (
                      <div>
                        {d.count} direct · {d.sent} sent · clicks {pct(d.clicked, d.sent)}
                      </div>
                    ) : null}
                    {a.outcomes?.journeys.length ? <div className="text-muted">{a.outcomes.journeys.length} journeys measured</div> : null}
                    {!b && !d && !a.outcomes?.journeys.length ? <span className="text-muted">—</span> : null}
                  </Td>
                  <Td className="whitespace-nowrap text-[12px]">
                    {a.goalsTotal ? `${a.goalsMet} of ${a.goalsTotal} met` : <span className="text-muted">—</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-[12px]">
                    {a.ai.calls ? (
                      <>
                        {a.ai.calls} calls · {money(a.ai.cost)}
                        <div className="mt-0.5 text-muted">
                          {a.ai.inputTokens.toLocaleString('en-US')} in · {a.ai.outputTokens.toLocaleString('en-US')} out
                        </div>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableFrame>
    </Card>
  );
}
