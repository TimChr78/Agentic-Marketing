import { ACTION_CLASSES } from '@agentic-marketing/commands';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/registry';

// ADR-0016 (#214): the policy engine judges agent writes by what they change in the world, so every
// write an agent may run must declare its action class. People-only commands default from `effect`.

const agentCallable = commands.filter((c) => c.permission && !c.humansOnly);

describe('action classes', () => {
  it('every write an agent may run declares one', () => {
    const missing = agentCallable.filter((c) => c.effect !== 'read' && !c.actionClass).map((c) => c.name);
    expect(missing, 'add `actionClass` to these commands (see packages/commands/src/policy.ts)').toEqual([]);
  });

  it('reads are never classified as writes, and every class is a known one', () => {
    for (const c of commands) {
      if (!c.actionClass) continue;
      expect(ACTION_CLASSES, c.name).toContain(c.actionClass);
      if (c.effect === 'read') expect(c.actionClass, c.name).toBe('read');
    }
  });

  it('only commands that can wait for a person are approvable', () => {
    expect(commands.filter((c) => c.approvable).map((c) => c.name)).toEqual(['artifacts.requestPublish', 'artifacts.requestPublishBundle']);
  });
});
