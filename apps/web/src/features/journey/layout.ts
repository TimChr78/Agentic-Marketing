import { edgesOf, type JNode } from './model';

// Positions for nodes that have none (agent-written journeys): layered top-to-bottom by distance
// from the trigger, siblings side by side. Stored positions always win.
export const NODE_W = 240;
export const NODE_H = 72;
const GAP_X = 48;
const GAP_Y = 64;

export function autoLayout(nodes: JNode[]): Record<string, { x: number; y: number }> {
  const edges = edgesOf(nodes);
  const depth = new Map<string, number>();
  const start = nodes.find((n) => n.kind === 'trigger') ?? nodes[0];
  if (start) {
    const queue = [start.id];
    depth.set(start.id, 0);
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of edges.filter((x) => x.source === id))
        if (!depth.has(e.target)) {
          depth.set(e.target, depth.get(id)! + 1);
          queue.push(e.target);
        }
    }
  }
  let maxDepth = Math.max(0, ...depth.values());
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, ++maxDepth);
  const rows = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id)!;
    rows.set(d, [...(rows.get(d) ?? []), n.id]);
  }
  const out: Record<string, { x: number; y: number }> = {};
  for (const [d, ids] of rows) {
    const width = ids.length * NODE_W + (ids.length - 1) * GAP_X;
    ids.forEach((id, i) => {
      out[id] = { x: i * (NODE_W + GAP_X) - width / 2 + NODE_W / 2, y: d * (NODE_H + GAP_Y) };
    });
  }
  return out;
}

export type Positions = Record<string, { x: number; y: number }>;

export function positionsOf(nodes: JNode[], layout?: Positions | null) {
  const auto = autoLayout(nodes);
  return Object.fromEntries(nodes.map((n) => [n.id, layout?.[n.id] ?? n.position ?? auto[n.id]!]));
}

/**
 * Version content with the saved layout on top. The layout record is the latest arrangement; the
 * version's own positions are the fallback for journeys nobody has moved since.
 */
export function withLayout<C extends { nodes?: JNode[] }>(content: C, layout?: Positions | null): C {
  if (!layout || !content.nodes) return content;
  return { ...content, nodes: content.nodes.map((n) => (layout[n.id] ? { ...n, position: layout[n.id] } : n)) };
}
