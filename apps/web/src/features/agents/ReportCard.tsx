import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Card } from '../../ui';
import { ACTION_CLASS_LABEL } from './labels';

const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');

/** What the agent did and what it led to in the last 30 days (#310). Hidden until it has acted. */
export function ReportCard({ agentId }: { agentId: string }) {
  const report = useApi(() => api.call('agents.report', { agentId }), [agentId]);
  const r = report.data;
  if (!r || Object.keys(r.actions).length === 0) return null;
  const b = r.outcomes?.broadcasts;
  const d = r.outcomes?.direct;
  return (
    <Card title="Last 30 days" description="What this agent did and what it led to. agents.report has the same, for any period.">
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted">Actions</div>
          <ul className="space-y-0.5 text-[13px]">
            {Object.entries(r.actions).map(([cls, c]) => (
              <li key={cls}>
                {ACTION_CLASS_LABEL[cls] ?? cls}: {c.allow} ran
                {c.hold ? `, ${c.hold} held` : ''}
                {c.ask ? `, ${c.ask} to a person` : ''}
                {c.deny ? `, ${c.deny} refused` : ''}
              </li>
            ))}
          </ul>
          {(r.undone > 0 || Object.keys(r.guardian).length > 0) && (
            <p className="mt-2 text-[12px] text-muted">
              {r.undone} undone · guardian episodes: {Object.values(r.guardian).reduce((n, x) => n + x, 0)}
            </p>
          )}
        </div>
        <div className="space-y-2 text-[13px]">
          {b && (
            <div>
              <div className="text-[12px] font-medium text-muted">{b.count} broadcasts</div>
              {b.sent} sent · opens {pct(b.opened, b.sent)} · clicks {pct(b.clicked, b.sent)} · unsubscribes {pct(b.unsubscribed, b.sent)}
            </div>
          )}
          {d && (
            <div>
              <div className="text-[12px] font-medium text-muted">{d.count} direct messages</div>
              {d.sent} sent · clicks {pct(d.clicked, d.sent)} · unsubscribes {pct(d.unsubscribed, d.sent)}
            </div>
          )}
          {r.outcomes?.goals.map((g) => (
            <div key={g.measure}>
              Goal {g.measure} {g.direction === 'up' ? '≥' : '≤'} {g.target ?? '—'}: {g.value ?? '—'}{' '}
              {g.met === true ? '(met)' : g.met === false ? '(not met)' : g.note ? `(${g.note})` : ''}
            </div>
          ))}
          {r.outcomes?.journeys.map((j) => (
            <div key={j.id} className="text-[12px] text-muted">
              Journey {j.id}: {j.note}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
