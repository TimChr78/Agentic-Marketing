import { stateOfAgent } from '../../lib/state';
import { StatusPill } from '../../ui';
import { OperationalPill } from '../../ui/state';
import { type Agent, type AgentDecision, DECISION } from './labels';

/** An agent's operational state: active, paused, held by the guardian, or revoked. Text plus marker. */
export function AgentStatusPill({
  status,
  guard,
  statusReason,
}: {
  status: Agent['status'];
  guard?: Agent['guard'];
  statusReason?: string | null;
}) {
  const state = stateOfAgent({ status, guard, statusReason });
  return (
    <span title={state.detail}>
      <OperationalPill state={state} />
    </span>
  );
}

/** One policy decision: allowed, waited for a person, or refused. */
export function DecisionBadge({ decision }: { decision: AgentDecision }) {
  const d = DECISION[decision];
  return <StatusPill tone={d.tone}>{d.label}</StatusPill>;
}
