import { StatusPill } from '../../ui';
import { AGENT_STATUS, type AgentDecision, type AgentStatus, DECISION } from './labels';

/** An agent's status: text plus colour, never colour alone. */
export function AgentStatusPill({ status }: { status: AgentStatus }) {
  const s = AGENT_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

/** One policy decision: allowed, waited for a person, or refused. */
export function DecisionBadge({ decision }: { decision: AgentDecision }) {
  const d = DECISION[decision];
  return <StatusPill tone={d.tone}>{d.label}</StatusPill>;
}
