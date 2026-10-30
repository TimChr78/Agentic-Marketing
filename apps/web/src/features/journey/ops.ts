import { NODE_H } from './layout';
import { DEFAULTS, type JNode, KINDS, materialize, maxEdges, type NodeKind, newNodeId } from './model';

// Graph edits on the stored JSON (#33). Edges are positional (`next[i]` is outcome i: yes/no,
// matched/timeout, split path, AI option), so removing an outcome in the middle would silently
// change the meaning of the ones after it; instead that outcome is pointed at a new Exit step.

export interface EditResult {
  nodes: JNode[];
  note?: string;
  select?: string;
}

const clone = (nodes: JNode[]): JNode[] => materialize(nodes).map((n) => ({ ...n, next: n.next ? [...n.next] : [] }));

export function addNode(
  nodes: JNode[],
  kind: NodeKind,
  position: { x: number; y: number },
  after?: { source: string; index: number },
): EditResult {
  const out = clone(nodes);
  if (kind === 'trigger' && out.some((n) => n.kind === 'trigger'))
    return { nodes, note: 'A journey has one trigger. Edit the existing one instead.' };
  const id = newNodeId(out);
  out.push({ id, kind, label: KINDS[kind].label, config: structuredClone(DEFAULTS[kind]), next: [], position });
  if (after) {
    const src = out.find((n) => n.id === after.source);
    if (src && after.index <= (src.next?.length ?? 0) && after.index < maxEdges(src)) {
      src.next![after.index] = { to: id };
    }
  }
  return { nodes: out, select: id };
}

export function connect(nodes: JNode[], source: string, index: number, target: string): EditResult {
  const out = clone(nodes);
  const src = out.find((n) => n.id === source);
  if (!src || source === target) return { nodes };
  if (index >= maxEdges(src)) return { nodes, note: `${src.label} has no more outcomes to connect.` };
  if (index > src.next!.length) return { nodes, note: 'Connect the outcomes in order: the first one first.' };
  if (out.find((n) => n.id === target)?.kind === 'trigger') return { nodes, note: 'Nothing can lead into the trigger.' };
  src.next![index] = { ...(src.next![index]?.label ? { label: src.next![index]!.label } : {}), to: target };
  return { nodes: out };
}

export function disconnect(nodes: JNode[], source: string, index: number): EditResult {
  const out = clone(nodes);
  const src = out.find((n) => n.id === source);
  if (!src?.next?.[index]) return { nodes };
  if (index === src.next.length - 1) {
    src.next.pop();
    return { nodes: out };
  }
  const id = newNodeId(out);
  const at = src.position ?? { x: 0, y: 0 };
  out.push({ id, kind: 'exit', label: 'Exit', config: {}, next: [], position: { x: at.x + 40 * index, y: at.y + NODE_H + 80 } });
  src.next[index] = { to: id };
  return { nodes: out, note: 'That outcome now ends in a new Exit step, so the later outcomes keep their meaning.' };
}

export function deleteNode(nodes: JNode[], id: string): EditResult {
  let out = clone(nodes);
  const victim = out.find((n) => n.id === id);
  if (!victim) return { nodes };
  let note: string | undefined;
  for (const n of out)
    for (let i = (n.next?.length ?? 0) - 1; i >= 0; i--)
      if (n.next![i]!.to === id) {
        const r = disconnect(out, n.id, i);
        out = r.nodes;
        note = r.note ?? note;
      }
  out = out.filter((n) => n.id !== id);
  return { nodes: out, note };
}

export function duplicateNode(nodes: JNode[], id: string): EditResult {
  const out = clone(nodes);
  const src = out.find((n) => n.id === id);
  if (!src || src.kind === 'trigger') return { nodes };
  const nid = newNodeId(out);
  out.push({
    ...structuredClone(src),
    id: nid,
    label: `${src.label} (copy)`,
    next: [],
    position: { x: (src.position?.x ?? 0) + 32, y: (src.position?.y ?? 0) + 32 },
  });
  return { nodes: out, select: nid };
}

/** Writes positions for every node (auto-laid-out ones included), so the canvas and JSON agree. */
export function withPositions(nodes: JNode[], pos: Record<string, { x: number; y: number }>): JNode[] {
  return nodes.map((n) => ({ ...n, position: pos[n.id] ? { x: Math.round(pos[n.id]!.x), y: Math.round(pos[n.id]!.y) } : n.position }));
}
