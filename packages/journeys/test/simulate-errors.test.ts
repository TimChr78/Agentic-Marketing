import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it, vi } from 'vitest';

// #885: journeys.simulate wrapped every compile failure into
// "This journey cannot run: <text>". A node config that does not validate, or a definition that
// cannot run, is the journey's own problem and keeps its message; anything else (a bug, a future
// failure inside compile) propagates for the executor to answer and audit as the fixed sanitised
// internal failure.
const SECRET = 'driver failure: password=probe-secret';
const state = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('../src/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/graph')>();
  return {
    ...actual,
    compile: (...args: Parameters<typeof actual.compile>) => {
      if (state.failure) throw state.failure;
      return actual.compile(...args);
    },
  };
});

const { simulateJourney } = await import('../src/commands');
const { compile, JourneyCompileError } = await import('../src/graph');

const JOURNEY = `jrny_${'a'.repeat(32)}`;

/** The newest version's content, as loadDefinition reads it. */
const definition = { purpose: 'marketing_email', nodes: [{ id: 'n1', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' } }] };

function fakeTx(content: unknown) {
  const rows = [{ number: 1, content }];
  const chain = Object.assign(rows, { orderBy: () => ({ limit: async () => rows }) });
  return { select: () => ({ from: () => ({ where: () => chain }) }) };
}

const context = (tx: unknown): CommandContext =>
  ({
    tx,
    principal: { workspaceId: 'ws_test', userId: 'usr_owner', type: 'user', permissions: new Set(['artifacts:read']) },
  }) as unknown as CommandContext;

const rejection = <T>(promise: Promise<T>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

const simulate = (ctx: CommandContext) =>
  simulateJourney.handler({ artifactId: JOURNEY, events: [], branches: {}, actions: {}, ai: {}, scores: {}, maxDays: 90 }, ctx);

describe('journeys.simulate compile failures (#885)', () => {
  it('lets an unexpected compile failure propagate', async () => {
    state.failure = new Error(SECRET);
    try {
      const err = (await rejection(simulate(context(fakeTx(definition))))) as Error | null;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppError);
    } finally {
      state.failure = null;
    }
  });

  it('keeps a definition that cannot run, which the author can fix', async () => {
    state.failure = new JourneyCompileError('sms nodes cannot run yet');
    try {
      const err = (await rejection(simulate(context(fakeTx(definition))))) as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.message).toBe('This journey cannot run: sms nodes cannot run yet');
    } finally {
      state.failure = null;
    }
  });

  it('runs a valid definition, so the switch above is not hiding a broken mock', async () => {
    const out = await simulate(context(fakeTx(definition)));
    expect(out.outcome).toBeDefined();
  });
});

describe('compile’s own failures are typed (#885)', () => {
  it('marks a journey without a trigger as expected', () => {
    expect(() => compile({ purpose: 'marketing_email', nodes: [] } as never)).toThrow(JourneyCompileError);
  });
});
