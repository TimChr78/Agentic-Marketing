import { describe, expect, it } from 'vitest';
import type { JNode } from '../../journey/model';
import { autoLayoutNodes } from './autoLayout';
import { graphWarnings, issueLabel, issueTotal, nodeIssueText } from './validation';

const graph = (): JNode[] => [
  { id: 'n1', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'n2' }], position: { x: 900, y: 700 } },
  {
    id: 'n2',
    kind: 'branch',
    label: 'Engaged?',
    config: { condition: { trait: 'plan', op: 'eq', value: 'pro' } },
    next: [{ to: 'n3' }, { to: 'n4' }],
    position: { x: 900, y: 900 },
  },
  { id: 'n3', kind: 'email', label: 'Nudge', config: { template: 'eml_a' }, position: { x: 400, y: 300 } },
  { id: 'n4', kind: 'exit', label: 'Exit', config: {}, position: { x: 1200, y: 300 } },
  { id: 'n5', kind: 'wait', label: 'Orphan wait', config: { duration: 'P1D' } },
];

describe('journey auto-layout (#528)', () => {
  it('changes presentation positions only and keeps graph semantics frozen', () => {
    const before = graph();
    const after = autoLayoutNodes(before);

    expect(after.map((n) => n.id)).toEqual(before.map((n) => n.id));
    expect(after.map((n) => n.kind)).toEqual(before.map((n) => n.kind));
    expect(after.map((n) => n.label)).toEqual(before.map((n) => n.label));
    expect(after.map((n) => n.config)).toEqual(before.map((n) => n.config));
    expect(after.map((n) => n.next)).toEqual(before.map((n) => n.next));
    expect(after.every((n) => n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
    expect(after.map((n) => n.position)).not.toEqual(before.map((n) => n.position));
    // The input is untouched.
    expect(before[0]!.position).toEqual({ x: 900, y: 700 });
  });

  it('terminates for a cyclic graph and gives every step a position', () => {
    const cyclic: JNode[] = [
      { id: 'a', kind: 'trigger', label: 'A', config: { event: 'x' }, next: [{ to: 'b' }] },
      { id: 'b', kind: 'wait', label: 'B', config: { duration: 'P1D' }, next: [{ to: 'c' }] },
      { id: 'c', kind: 'branch', label: 'C', config: { segment: 'seg_a' }, next: [{ to: 'a' }, { to: 'b' }] },
    ];
    const after = autoLayoutNodes(cyclic);
    expect(after).toHaveLength(3);
    expect(after.every((n) => n.position)).toBe(true);
  });

  it('terminates for a disconnected graph with no trigger', () => {
    const disconnected: JNode[] = [
      { id: 'a', kind: 'email', label: 'A', config: {} },
      { id: 'b', kind: 'email', label: 'B', config: {} },
      { id: 'c', kind: 'exit', label: 'C', config: {} },
    ];
    const after = autoLayoutNodes(disconnected);
    expect(after).toHaveLength(3);
    expect(after.every((n) => n.position)).toBe(true);
  });
});

describe('journey issue labels (#528)', () => {
  it('counts node and graph-level issues together', () => {
    expect(issueLabel(1)).toBe('1 issue');
    expect(issueLabel(3)).toBe('3 issues');
    expect(issueTotal({ a: ['one', 'two'], b: ['three'] }, ['graph'])).toBe(4);
  });

  it('keeps graph-level warnings separate, in order and deduplicated', () => {
    expect(
      graphWarnings([
        { nodeId: 'a', message: 'A step issue' },
        { nodeId: null, message: 'The journey needs a purpose.' },
        { nodeId: null, message: 'The journey needs a purpose.' },
        { nodeId: null, message: 'The journey needs a goal.' },
      ]),
    ).toEqual(['The journey needs a purpose.', 'The journey needs a goal.']);
  });

  it('shows a field message on a step, but never repeats the word trigger on a disconnected step', () => {
    expect(nodeIssueText(['Choose the e-mail template to send.'])).toBe('Choose the e-mail template to send.');
    const unreachable = nodeIssueText(['Not reachable from the trigger: connect a step to it.']);
    expect(unreachable).toBe('Not connected to the start yet.');
    expect(unreachable.toLowerCase()).not.toContain('trigger');
  });
});
