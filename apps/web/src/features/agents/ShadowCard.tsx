import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Card } from '../../ui';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Shadow mode (#256): how the mandate's would-have-done decisions compare with what people did,
 * over the last 30 days. Hidden when the agent has no shadow decisions.
 */
export function ShadowCard({ agentId }: { agentId: string }) {
  const report = useApi(() => api.call('agents.shadowReport', { agentId, limit: 500 }), [agentId]);
  const s = report.data?.summary;
  if (!s || s.total === 0) return null;
  const stats: [string, number, string][] = [
    ['Agree', s.agree, 'It would have run and a person approved, or it would have asked and a person rejected.'],
    ['Too bold', s.tooBold, 'It would have run, but a person rejected the change.'],
    ['Too cautious', s.tooCautious, 'It would have asked, but a person approved.'],
    ['Waiting', s.pending, 'No person has decided yet.'],
    ['Not reviewed', s.unreviewed, 'The approval policy let it run without a person.'],
  ];
  return (
    <Card
      title="Shadow mode"
      description="The mandate only records what this agent would have done; people decide as before. Compare before granting the level for real."
    >
      <div className="flex flex-wrap gap-6 p-4">
        <div>
          <div className="text-[12px] text-muted">Agreement</div>
          <div className="text-[22px] font-semibold">{s.agreementRate === null ? '—' : pct(s.agreementRate)}</div>
          <div className="text-[12px] text-muted">of {s.total} changes in 30 days</div>
        </div>
        {stats.map(([label, n, hint]) => (
          <div key={label} title={hint}>
            <div className="text-[12px] text-muted">{label}</div>
            <div className="text-[22px] font-semibold">{n}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
