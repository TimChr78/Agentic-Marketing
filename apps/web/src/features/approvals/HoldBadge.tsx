import { StatusPill } from '../../ui';
import { holdCountdownText } from './holds';

/** A held agent change: its mandate lets it run after a veto window, unless a person vetoes it. */
export function HoldBadge() {
  return <StatusPill tone="warn">Held by an agent’s mandate</StatusPill>;
}

/** The live sentence for a hold, e.g. "Runs in 1 h 12 min unless rejected". */
export function HoldCountdown({ holdUntil, now }: { holdUntil: string; now: number }) {
  return (
    <span className="text-[12px] text-fg-2" aria-live="polite">
      {holdCountdownText(holdUntil, now)}
    </span>
  );
}
