import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { withNodeStats } from '../src/features/journey/canvas';

const nodes = (): Node[] => [
  { id: 'n1', position: { x: 10, y: 20 }, selected: true, data: { label: 'Start' } },
  { id: 'n2', position: { x: 300, y: 20 }, data: { label: 'Wait' } },
];

describe('journey canvas stats updates (#383)', () => {
  it('updates node data without moving or replacing the in-progress canvas nodes', () => {
    const before = nodes();
    const after = withNodeStats(before, { reached: { n1: 12 }, waitingAt: { n1: 3, n2: 4 } });

    expect(after[0]!.position).toEqual({ x: 10, y: 20 });
    expect(after[1]!.position).toEqual({ x: 300, y: 20 });
    expect(after[0]!.selected).toBe(true);
    expect(after[0]!.id).toBe('n1');
    expect(after[0]!.data.stats).toEqual({ reached: 12, waiting: 3 });
    expect(after[1]!.data.stats).toEqual({ reached: 0, waiting: 4 });
    // The incoming nodes are not mutated: a drag snapshot remains the user's.
    expect(before[0]!.data.stats).toBeUndefined();
  });

  it('keeps drag positions when the saved model still has the old ones', () => {
    const dragged = nodes().map((n) => ({ ...n, position: { x: n.position.x + 150, y: n.position.y + 40 } }));
    const after = withNodeStats(dragged, { reached: {}, waitingAt: {} });

    expect(after.map((n) => n.position)).toEqual([
      { x: 160, y: 60 },
      { x: 450, y: 60 },
    ]);
  });

  it('clears stats without touching the rest of the node', () => {
    const before = withNodeStats(nodes(), { reached: { n1: 1 }, waitingAt: {} });
    const after = withNodeStats(before, undefined);
    expect(after[0]!.data.stats).toBeUndefined();
    expect(after[0]!.position).toEqual(before[0]!.position);
  });
});
