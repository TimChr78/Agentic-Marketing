import { describe, expect, it } from 'vitest';
import { localWarnings, mergeWarnings } from '../src/features/journey/checks';
import { positionsOf, withLayout } from '../src/features/journey/layout';
import { edgesOf, type JNode, materialize } from '../src/features/journey/model';
import { addNode, connect, deleteNode, disconnect, duplicateNode } from '../src/features/journey/ops';

const base = (): JNode[] => [
  { id: 'n1', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'n2' }] },
  { id: 'n2', kind: 'branch', label: 'Engaged?', config: { segment: 'seg_0123456789abcdef0123456789abcdef' }, next: [{ to: 'n3' }, { to: 'n4' }] },
  { id: 'n3', kind: 'exit', label: 'Yes exit', config: {} },
  { id: 'n4', kind: 'email', label: 'Nudge', config: { template: '' } },
];

describe('journey graph edits (#33)', () => {
  it('makes implicit edges explicit and keeps edge labels', () => {
    const nodes: JNode[] = [
      { id: 'a', kind: 'trigger', label: 'A', config: { event: 'x' } },
      { id: 'b', kind: 'waitEvent', label: 'B', config: {}, next: [{ to: 'c', label: 'opened' }] },
      { id: 'c', kind: 'exit', label: 'C', config: {} },
    ];
    expect(materialize(nodes).map((n) => n.next)).toEqual([[{ to: 'b' }], [{ to: 'c', label: 'opened' }], []]);
  });

  it('adds a step after another and connects it', () => {
    const r = addNode(base(), 'wait', { x: 0, y: 0 }, { source: 'n4', index: 0 });
    expect(r.select).toBe('n5');
    expect(r.nodes.find((n) => n.id === 'n4')!.next).toEqual([{ to: 'n5' }]);
    expect(addNode(base(), 'trigger', { x: 0, y: 0 }).note).toMatch(/one trigger/);
  });

  it('connects outcomes in order only, and never into the trigger', () => {
    const nodes = base().map((n) => (n.id === 'n2' ? { ...n, next: [] } : n));
    expect(connect(nodes, 'n2', 1, 'n3').note).toMatch(/in order/);
    expect(connect(nodes, 'n2', 0, 'n3').nodes.find((n) => n.id === 'n2')!.next).toEqual([{ to: 'n3' }]);
    expect(connect(nodes, 'n4', 0, 'n1').note).toMatch(/trigger/);
  });

  it('removing the yes outcome of a branch keeps no as no, through a new Exit', () => {
    const r = disconnect(base(), 'n2', 0);
    const branch = r.nodes.find((n) => n.id === 'n2')!;
    expect(branch.next).toHaveLength(2);
    expect(branch.next![1]).toEqual({ to: 'n4' });
    expect(r.nodes.find((n) => n.id === branch.next![0]!.to)!.kind).toBe('exit');
    expect(r.note).toMatch(/keep their meaning/);
    // The last outcome is simply removed.
    expect(disconnect(base(), 'n2', 1).nodes.find((n) => n.id === 'n2')!.next).toEqual([{ to: 'n3' }]);
  });

  it('deleting a step removes the edges into it', () => {
    const r = deleteNode(base(), 'n4');
    expect(r.nodes.map((n) => n.id)).not.toContain('n4');
    expect(edgesOf(r.nodes).every((e) => e.target !== 'n4')).toBe(true);
  });

  it('duplicates a step without its edges, but never the trigger', () => {
    const r = duplicateNode(base(), 'n4');
    expect(r.nodes.find((n) => n.id === r.select)!.next).toEqual([]);
    expect(duplicateNode(base(), 'n1').nodes).toHaveLength(4);
  });

  it('marks incomplete steps and merges the server warnings', () => {
    const w = localWarnings(base());
    expect(w.n4?.[0]).toMatch(/template/);
    expect(w.n1).toBeUndefined();
    const merged = mergeWarnings(w, [{ nodeId: 'n2', message: 'Segment is not published' }]);
    expect(merged.n2).toEqual(['Segment is not published']);
  });

  it('reads the saved layout before the version positions, then auto layout (#117)', () => {
    const nodes: JNode[] = [
      { id: 'a', kind: 'trigger', label: 'A', config: {}, position: { x: 1, y: 2 } },
      { id: 'b', kind: 'exit', label: 'B', config: {} },
    ];
    expect(positionsOf(nodes, { a: { x: 9, y: 9 } })).toMatchObject({ a: { x: 9, y: 9 } });
    expect(positionsOf(nodes, { b: { x: 5, y: 6 } })).toMatchObject({ a: { x: 1, y: 2 }, b: { x: 5, y: 6 } });
    expect(positionsOf(nodes).a).toEqual({ x: 1, y: 2 });
  });

  it('overlays the layout on version content without mutating it', () => {
    const content = {
      nodes: [
        { id: 'a', kind: 'trigger' as const, label: 'A', config: {}, position: { x: 1, y: 2 } },
        { id: 'b', kind: 'exit' as const, label: 'B', config: {}, position: { x: 3, y: 4 } },
      ],
    };
    const merged = withLayout(content, { a: { x: 9, y: 9 } });
    expect(merged.nodes?.[0]?.position).toEqual({ x: 9, y: 9 });
    expect(merged.nodes?.[1]?.position).toEqual({ x: 3, y: 4 });
    expect(content.nodes[0]!.position).toEqual({ x: 1, y: 2 });
  });
});
