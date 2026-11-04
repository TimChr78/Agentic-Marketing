import type { Node } from '@xyflow/react';

export interface StepStats {
  reached: Record<string, number>;
  waitingAt: Record<string, number>;
}

/**
 * Attaches live stats to the existing canvas nodes without rebuilding them (#383).
 *
 * Positions, selection and drag state stay exactly as React Flow has them, so a poll that lands
 * mid-drag cannot snap a step back to its saved position or discard an unsaved layout.
 */
export function withNodeStats(nodes: Node[], stats: StepStats | undefined): Node[] {
  return nodes.map((node) => {
    const next = stats ? { reached: stats.reached[node.id] ?? 0, waiting: stats.waitingAt[node.id] ?? 0 } : undefined;
    const previous = (node.data as { stats?: typeof next }).stats;
    if (JSON.stringify(previous) === JSON.stringify(next)) return node;
    return { ...node, data: { ...node.data, stats: next } };
  });
}
