import type { JourneyEdge, JourneyNode } from '../api/types';

// Simple top-to-bottom layered layout (stand-in for ELK.js in the real UI).
export function layoutGraph(nodes: JourneyNode[], edges: JourneyEdge[]): JourneyNode[] {
  const incoming = new Map<string, number>();
  nodes.forEach((n) => incoming.set(n.id, 0));
  edges.forEach((e) => incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1));
  const level = new Map<string, number>();
  const queue = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  queue.forEach((id) => level.set(id, 0));
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges.filter((x) => x.source === id)) {
      const next = (level.get(id) ?? 0) + 1;
      if ((level.get(e.target) ?? -1) < next) {
        level.set(e.target, next);
        queue.push(e.target);
      }
    }
  }
  const byLevel = new Map<number, string[]>();
  nodes.forEach((n) => {
    const l = level.get(n.id) ?? 0;
    byLevel.set(l, [...(byLevel.get(l) ?? []), n.id]);
  });
  return nodes.map((n) => {
    const l = level.get(n.id) ?? 0;
    const row = byLevel.get(l)!;
    const i = row.indexOf(n.id);
    return { ...n, position: { x: 260 + (i - (row.length - 1) / 2) * 300, y: l * 175 } };
  });
}
