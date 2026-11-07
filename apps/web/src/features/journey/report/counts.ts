import type { Node } from '@xyflow/react';

/**
 * Journey counts shared by the builder canvas, the read-only graph and the report (#507).
 *
 * The records are exactly what `journeys.stats` returned: a node id that is absent was not
 * observed at all, and must stay unavailable. It is never a zero. A returned `0` is an observed
 * zero and is shown as such.
 */
export interface JourneyCounts {
  reached: Record<string, number>;
  waitingAt: Record<string, number>;
}

/** Count data on one canvas node, plus the caption the caller supplied. */
export interface NodeCounts {
  reached?: number;
  waiting?: number;
  label?: string;
}

/** The canvas badge caption required by the contract. */
export const COUNTS_LABEL = 'All versions · reached all time / waiting now';

export function countFor(id: string, counts: JourneyCounts | undefined, label?: string): NodeCounts | undefined {
  if (!counts) return undefined;
  const reached = Object.hasOwn(counts.reached, id) ? counts.reached[id] : undefined;
  const waiting = Object.hasOwn(counts.waitingAt, id) ? counts.waitingAt[id] : undefined;
  return {
    ...(reached === undefined ? {} : { reached }),
    ...(waiting === undefined ? {} : { waiting }),
    ...(label ? { label } : {}),
  };
}

/**
 * Attaches counts to existing canvas nodes without rebuilding them, so a drag or a selection in
 * progress is never discarded. Missing keys stay absent rather than becoming zero.
 */
export function withNodeCounts(nodes: Node[], counts: JourneyCounts | undefined, label?: string): Node[] {
  return nodes.map((node) => {
    const next = countFor(node.id, counts, label);
    const previous = (node.data as { stats?: NodeCounts }).stats;
    if (JSON.stringify(previous) === JSON.stringify(next)) return node;
    return { ...node, data: { ...node.data, stats: next } };
  });
}

/** "1,200 reached all time · 0 waiting now" with explicit Unavailable for an absent key. */
export function countText(counts: NodeCounts): string {
  const reached = counts.reached === undefined ? 'Unavailable' : counts.reached.toLocaleString();
  const waiting = counts.waiting === undefined ? 'Unavailable' : counts.waiting.toLocaleString();
  return `${reached} reached all time · ${waiting} waiting now`;
}
