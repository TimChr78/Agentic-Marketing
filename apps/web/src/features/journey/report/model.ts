import type { Out } from '../../../app/api';
import type { JNode } from '../model';

// Pure reads and the funnel gate for the Phase 26 journey report (#507). Everything here stays
// free of React and of the API so the exact rules can be unit tested.

type StatsResult = Out<'journeys.stats'>;
type FunnelResult = Out<'analytics.journeyFunnel'>;

export const BRANCH_NOTICE = 'This journey branches. Step reach is not a cohort funnel.';
export const LOOP_NOTICE = 'This journey loops. Step reach is not a cohort funnel.';
export const UNMAPPED_NOTICE = 'Some steps are outside the published topology. Step reach is not a cohort funnel.';
export const MISSING_NOTICE = 'Some steps have no recorded reach. Step reach is not a cohort funnel.';
export const SUPPRESSED_NOTICE = 'Some step counts are suppressed. Step reach is not a cohort funnel.';
export const NONMONOTONE_NOTICE = 'Step reach is not monotone. Step reach is not a cohort funnel.';
export const VERSION_NOTICE = 'Saved versions differ, so version-specific counts are unavailable. Step reach is not a cohort funnel.';
export const EMPTY_NOTICE = 'No participants entered this period. Step reach is not a cohort funnel.';
export const REACH_NOTICE =
  'The server reports reach, not a drop-off chain. Drop-off is shown only for linear journeys. A linear journey whose step counts rise (for example after a migration) is reach too.';

export type GateReason =
  | 'reach'
  | 'branching'
  | 'looping'
  | 'unmapped'
  | 'missing-stage'
  | 'suppressed'
  | 'nonmonotone'
  | 'versioned'
  | 'empty';

export interface FunnelStage {
  /** The node id, or null for the "Entered" stage. */
  step: string | null;
  label: string;
  reached: number;
  /** People lost against the previous stage; null for the first stage. */
  difference: number | null;
  /** Difference divided by the previous stage's reach; null when there is no denominator. */
  differenceRate: number | null;
}

export type FunnelGateResult = { pass: true; stages: FunnelStage[]; notice: string } | { pass: false; reason: GateReason; notice: string };

export interface FunnelGateInput {
  /** The server's basis: only a published straight line can carry a drop-off chain. */
  basis?: FunnelResult['basis'];
  latestVersion: number | null;
  publishedVersion: number | null;
  nodes: JNode[];
  steps: { step: string; reached: number | null }[];
  entered: number | null;
  suppressed: number;
  k?: number | null;
}

const fail = (reason: GateReason, notice: string): FunnelGateResult => ({ pass: false, reason, notice });

/**
 * The funnel gate (#507). A funnel is only honest for one linear published topology whose event
 * steps all map to it, on this phase's single-version provenance, with every stage present,
 * unsuppressed, monotone reach and at least one entrant. Anything else gets independent bars and
 * an explanation; a negative difference is never clamped or hidden. The server's reach basis
 * always wins: it is the one statement that knows the topology it counted (#591).
 */
export function funnelGate(input: FunnelGateInput): FunnelGateResult {
  const { basis = 'published', nodes, steps, entered, suppressed } = input;
  if (basis === 'reach') return fail('reach', REACH_NOTICE);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // A single path from one trigger, with no branch or split step and no unreachable node.
  const triggers = nodes.filter((node) => node.kind === 'trigger');
  if (triggers.length !== 1) return fail('branching', BRANCH_NOTICE);
  const order: JNode[] = [];
  const seen = new Set<string>();
  let current: JNode | undefined = triggers[0];
  while (current) {
    if (seen.has(current.id)) return fail('looping', LOOP_NOTICE);
    seen.add(current.id);
    order.push(current);
    const next = current.next ?? [];
    if (current.kind === 'branch' || current.kind === 'split' || next.length > 1) return fail('branching', BRANCH_NOTICE);
    const target = next[0]?.to;
    if (!target) {
      current = undefined;
      continue;
    }
    const nextNode = byId.get(target);
    if (!nextNode) return fail('branching', BRANCH_NOTICE);
    current = nextNode;
  }
  if (seen.size !== nodes.length) return fail('branching', BRANCH_NOTICE);

  // Every event step must belong to the published topology.
  const stepById = new Map(steps.map((step) => [step.step, step]));
  for (const step of steps) if (!byId.has(step.step)) return fail('unmapped', UNMAPPED_NOTICE);

  if (input.latestVersion !== 1 || input.publishedVersion !== 1) return fail('versioned', VERSION_NOTICE);
  if (suppressed > 0) return fail('suppressed', SUPPRESSED_NOTICE);
  if (entered === null || entered <= 0) return fail('empty', EMPTY_NOTICE);

  // Goal and exit are not sequential stages: a goal can be reached independently of the path.
  const stageNodes = order.slice(1).filter((node) => node.kind !== 'goal' && node.kind !== 'exit');
  const stages: FunnelStage[] = [{ step: null, label: 'Entered', reached: entered, difference: null, differenceRate: null }];
  let previous = entered;
  for (const node of stageNodes) {
    const step = stepById.get(node.id);
    if (!step || step.reached === null) return fail('missing-stage', MISSING_NOTICE);
    const reached = step.reached;
    const difference = previous - reached;
    if (difference < 0) return fail('nonmonotone', NONMONOTONE_NOTICE);
    stages.push({
      step: node.id,
      label: node.label || node.id,
      reached,
      difference,
      differenceRate: previous === 0 ? null : difference / previous,
    });
    previous = reached;
  }
  return {
    pass: true,
    stages,
    notice: 'Compatible linear topology; complete monotone steps. Event reach, not an entry cohort.',
  };
}

/** Whether two node lists describe the same steps and connections, ignoring saved positions. */
export function sameTopology(a: JNode[] | undefined, b: JNode[] | undefined): boolean {
  const key = (nodes: JNode[] | undefined) =>
    JSON.stringify(
      (nodes ?? []).map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        config: node.config,
        next: node.next ?? [],
      })),
    );
  return key(a) === key(b);
}

export interface CountsNow {
  ready: number;
  waiting: number;
  failed: number;
  completed: number;
  exited: number;
  converted: number;
}

export interface StatsView {
  /** A successful read gave every current-state count. */
  available: boolean;
  now: CountsNow | null;
  reached?: Record<string, number>;
  waitingAt?: Record<string, number>;
  duplicatesSkipped: number | null;
  missingKeySkipped: number | null;
}

const CURRENT_KEYS: (keyof CountsNow)[] = ['ready', 'waiting', 'failed', 'completed', 'exited', 'converted'];

/**
 * Reads `journeys.stats` without inventing values. A missing `now` block, or a missing current
 * count, leaves the read unavailable; the records stay undefined so callers can keep a missing
 * node key separate from a returned zero.
 */
export function readStats(raw: StatsResult | undefined): StatsView {
  const unavailable: StatsView = { available: false, now: null, duplicatesSkipped: null, missingKeySkipped: null };
  if (!raw || typeof raw !== 'object') return unavailable;
  const now = raw.now as Partial<CountsNow> | undefined;
  if (!now || CURRENT_KEYS.some((key) => typeof now[key] !== 'number')) return unavailable;
  return {
    available: true,
    now: Object.fromEntries(CURRENT_KEYS.map((key) => [key, now[key] as number])) as unknown as CountsNow,
    reached: raw.reached,
    waitingAt: raw.waitingAt,
    duplicatesSkipped: typeof raw.duplicatesSkipped === 'number' ? raw.duplicatesSkipped : null,
    missingKeySkipped: typeof raw.missingKeySkipped === 'number' ? raw.missingKeySkipped : null,
  };
}

export function nowTotal(view: StatsView): number {
  if (!view.available || !view.now) return 0;
  return CURRENT_KEYS.reduce((sum, key) => sum + (view.now?.[key] ?? 0), 0);
}

export interface StepRow {
  id: string;
  /** Null for an id the published topology cannot name. */
  label: string | null;
  kind: string | null;
  /** Selected-period reach from the funnel wrapper; null when absent or suppressed. */
  period: number | null;
  /** All-time distinct reach; null when the key was absent. */
  allTime: number | null;
  /** Current waiting count; null when the key was absent. */
  waiting: number | null;
}

export interface StepRowsInput {
  nodes: JNode[];
  steps: FunnelResult['steps'];
  reached?: Record<string, number>;
  waitingAt?: Record<string, number>;
}

export interface StepRowsResult {
  /** Rows whose ids the published topology can name, in graph order. */
  known: StepRow[];
  /** Rows the topology cannot name; kept as a separate historical list. */
  history: StepRow[];
}

/** Graph order, starting at the trigger and following saved connections. */
function graphOrder(nodes: JNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order = new Map<string, number>();
  const visit = (start: string | undefined) => {
    const seen = new Set<string>();
    let cursor = start ? byId.get(start) : undefined;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      order.set(cursor.id, order.size);
      cursor = cursor.next?.[0] ? byId.get(cursor.next[0]!.to) : undefined;
    }
  };
  visit(nodes.find((node) => node.kind === 'trigger')?.id);
  // Nodes the walk did not reach keep their saved array order after the connected path.
  for (const node of nodes) if (!order.has(node.id)) order.set(node.id, order.size);
  return order;
}

/**
 * Builds the step list from the ids the reads returned, never from every saved node: an id the
 * topology cannot name is a historical step, while a node with no event at all is not claimed as
 * an observed zero.
 */
export function stepRows({ nodes, steps, reached, waitingAt }: StepRowsInput): StepRowsResult {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  for (const step of steps) ids.add(step.step);
  for (const id of Object.keys(reached ?? {})) ids.add(id);
  for (const id of Object.keys(waitingAt ?? {})) ids.add(id);

  const periodByStep = new Map(steps.map((step) => [step.step, step.reached]));
  const order = graphOrder(nodes);
  const rows = Array.from(ids, (id): StepRow => {
    const node = byId.get(id);
    return {
      id,
      label: node?.label ?? null,
      kind: node?.kind ?? null,
      period: periodByStep.get(id) ?? null,
      allTime: reached && Object.hasOwn(reached, id) ? reached[id]! : null,
      waiting: waitingAt && Object.hasOwn(waitingAt, id) ? waitingAt[id]! : null,
    };
  }).sort(
    (a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  );

  return {
    known: rows.filter((row) => row.label !== null),
    history: rows.filter((row) => row.label === null),
  };
}

/** Null for a missing or epoch timestamp: the query time is never a substitute. */
export function freshnessOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return null;
  return value;
}

/** "120 / 812 entries = 14.8%", or an explicit reason when there is no denominator. */
export function conversionText(goalReached: number | null, entered: number | null): string {
  if (goalReached === null || entered === null) return 'Conversion unavailable';
  if (entered === 0) return 'No denominator available';
  const percent = (goalReached / entered) * 100;
  return `${goalReached.toLocaleString()} / ${entered.toLocaleString()} entries = ${percent.toFixed(1)}%`;
}

/** Count text that never turns a null into zero. */
export function countText(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : 'Unavailable';
}
