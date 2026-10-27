import { describe, expect, it } from 'vitest';
import { compile } from '../src/graph';
import { advance, type ParticipantState, pick } from '../src/interpreter';

const tpl = (n: number) => `eml_${String(n).padStart(32, '0')}`;
const welcome = compile({
  purpose: 'onboarding',
  nodes: [
    { id: 't', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up', reentry: 'once' } },
    { id: 'e1', kind: 'email', label: 'Welcome', config: { template: tpl(1) } },
    { id: 'w', kind: 'wait', label: 'Wait 2 days', config: { duration: 'P2D' } },
    {
      id: 'b',
      kind: 'branch',
      label: 'Gold?',
      config: { condition: { trait: 'tier', op: 'eq', value: 'gold' } },
      next: [{ to: 'e2' }, { to: 'g' }],
    },
    { id: 'e2', kind: 'email', label: 'Gold perks', config: { template: tpl(2) } },
    { id: 'g', kind: 'goal', label: 'Ordered', config: { event: 'Order Completed', within: 'P7D' }, next: [{ to: 'x' }, { to: 'x' }] },
    { id: 'x', kind: 'exit', label: 'Done', config: {} },
  ],
});
const fresh: ParticipantState = {
  node: 't',
  status: 'ready',
  seq: 0,
  dueAt: null,
  waitingEvent: null,
  waitingUntil: null,
  matched: false,
  converted: false,
};
const t0 = new Date('2026-10-22T10:00:00Z');
const env = { key: '1', branch: async () => false, condition: async () => false };

describe('journey interpreter', () => {
  it('runs until a wait, with keyed side effects', async () => {
    const out = await advance(welcome, fresh, t0, env);
    expect(out.effects).toEqual([{ kind: 'email', node: 'e1', seq: 2, template: tpl(1) }]);
    expect(out.state).toMatchObject({ node: 'w', status: 'waiting', seq: 3, dueAt: new Date('2026-10-24T10:00:00Z') });
  });

  it('resumes after the timer, branches, and waits for the goal', async () => {
    const waiting = (await advance(welcome, fresh, t0, env)).state;
    const out = await advance(welcome, waiting, new Date('2026-10-24T10:00:00Z'), { ...env, branch: async () => true });
    expect(out.effects.map((e) => e.node)).toEqual(['e2']);
    expect(out.state).toMatchObject({ node: 'g', status: 'waiting', waitingEvent: 'Order Completed' });
    const converted = await advance(welcome, { ...out.state, matched: true }, new Date('2026-10-25T10:00:00Z'), {
      ...env,
      branch: async () => true,
    });
    expect(converted.state).toMatchObject({ status: 'exited', converted: true, node: 'x' });
    expect(converted.steps.map((s) => s.type)).toEqual(['resumed', 'converted', 'step', 'exited']);
  });

  it('re-running the same step yields the same effect keys (idempotent sends)', async () => {
    const a = await advance(welcome, fresh, t0, env);
    const b = await advance(welcome, fresh, t0, env);
    expect(a.effects).toEqual(b.effects);
  });

  it('splits deterministically by participant', () => {
    const counts = [0, 0];
    for (let i = 0; i < 2000; i++) counts[pick([50, 50], `p${i}:s`)]++;
    expect(counts[0]).toBeGreaterThan(900);
    expect(counts[1]).toBeGreaterThan(900);
    expect(pick([10, 90], 'same')).toBe(pick([10, 90], 'same'));
  });
});
