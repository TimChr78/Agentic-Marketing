import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it, vi } from 'vitest';

// #885: workspace.create wrapped every normaliser failure into
// AppError('invalid_input', <raw text>). A domain the normaliser refuses is the caller's to fix and
// keeps its message; anything else (a bug) propagates so the executor answers and audits it as the
// fixed sanitised internal failure.
const SECRET = 'driver failure: password=probe-secret';
const state = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('@agentic-marketing/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentic-marketing/db')>();
  return {
    ...actual,
    normalizeDomainInput: (input: Parameters<typeof actual.normalizeDomainInput>[0]) => {
      if (state.failure) throw state.failure;
      return actual.normalizeDomainInput(input);
    },
  };
});

const { createWorkspace } = await import('../src/workspace');
const { DomainError } = await import('@agentic-marketing/db');

const context = (): CommandContext =>
  ({
    tx: { execute: async () => undefined },
    principal: { workspaceId: 'ws_test', userId: 'usr_owner', type: 'user', permissions: new Set<string>() },
    services: { ownsAnyWorkspace: async () => true },
  }) as unknown as CommandContext;

const create = (ctx: CommandContext) =>
  createWorkspace.handler({ name: 'Probe', primaryDomain: 'links.example.com' }, ctx).then(
    () => null,
    (e: unknown) => e as Error | null,
  );

describe('workspace.create domain validation failures (#885)', () => {
  it('lets an unexpected normaliser failure propagate', async () => {
    state.failure = new Error(SECRET);
    try {
      const err = await create(context());
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppError);
      expect(err?.message).toContain('probe-secret');
    } finally {
      state.failure = null;
    }
  });

  it('keeps a domain the caller can fix, with its own reason', async () => {
    state.failure = new DomainError('links.example.com is already registered to another brand.');
    try {
      const err = await create(context());
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('invalid_input');
      expect(err?.message).toBe('links.example.com is already registered to another brand.');
    } finally {
      state.failure = null;
    }
  });
});
