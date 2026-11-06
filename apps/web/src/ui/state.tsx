import { ArrowRight, Check, Clock, Hand, OctagonX, Pause, Square } from 'lucide-react';
import type { OperationalIcon, OperationalState } from '../lib/state';
import { cx } from './cx';
import { StatusPill, type Tone } from './display';

// Operational state pill (#437, DESIGN.md v2 → Operational state pills). 20 px high, 8 px padding,
// 6 px gap, neutral dot or a 14 px marker shape, and the state's own words. Noninteractive; a
// filter wraps a larger control rather than making the pill the hit target.

const MARKER = {
  clock: Clock,
  arrow: ArrowRight,
  check: Check,
  pause: Pause,
  octagon: OctagonX,
  square: Square,
  hand: Hand,
} as const;

function Marker({ icon }: { icon: OperationalIcon }) {
  if (icon === 'dot') return null;
  const Icon = MARKER[icon];
  return <Icon size={14} strokeWidth={1.75} aria-hidden />;
}

export function OperationalPill({ state, className }: { state: OperationalState; className?: string }) {
  return (
    <StatusPill tone={state.tone} className={className} dot={state.icon === 'dot'}>
      <Marker icon={state.icon} />
      {state.label}
      {state.detail && <span className="sr-only">. {state.detail}</span>}
    </StatusPill>
  );
}

/** A noninteractive pill for a metric's data state, with a title for the qualifying sentence. */
export function DataStatePill({ state, detail, className }: { state: { label: string; tone: Tone }; detail?: string; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center', className)} title={detail}>
      <StatusPill tone={state.tone}>{state.label}</StatusPill>
    </span>
  );
}
