import type { OperationalState } from '../../lib/state';
import { OperationalPill } from '../../ui/state';

/**
 * The operational pill for one broadcast. The state is always derived once by the caller from
 * `stateOfBroadcast` (the list passes the row from `broadcasts.list`, the detail page its one
 * `broadcasts.status` read) and shared with every slot; this component only renders it, so there is
 * no per-row `broadcasts.status` fan-out.
 */
export function BroadcastStatePill({ state, className }: { state: OperationalState; className?: string }) {
  return (
    <span title={state.detail}>
      <OperationalPill state={state} className={className} />
    </span>
  );
}
