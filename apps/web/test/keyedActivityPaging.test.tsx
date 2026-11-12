import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Deferred, deferred, settle } from './keyedReadsSupport';

// #611: the activity tab is not remounted when the agent id in the URL changes. The first page is
// keyed by agent, and the extra "Load more" pages must reset with that key, not after it.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_audit' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_audit' }, workspace: { id: 'ws_1' } }),
}));

import { ActivityTab } from '../src/features/agents/phase26/ActivityTab';
import type { AgentDetail } from '../src/features/agents/phase26/model';

const AGENT_A = `agt_${'a'.repeat(32)}`;
const AGENT_B = `agt_${'b'.repeat(32)}`;
const SINCE = '2026-11-05T00:00:00.000Z';

const action = (id: number, agentId: string, intent: string) => ({
  id,
  agentId,
  command: 'broadcasts.update',
  actionClass: 'content',
  decision: 'allow',
  mandateId: null,
  mandateVersion: null,
  intent,
  shadow: null,
  reasons: [],
  impact: {},
  ok: true,
  error: null,
  target: null,
  surface: 'web',
  at: '2026-11-05T10:00:00.000Z',
  undo: null,
  undoable: false,
  undoBlockedBy: null,
  undoneAt: null,
  undoneBy: null,
  undoResult: null,
});

const agent = { id: AGENT_A, guard: null } as unknown as AgentDetail;

let agentBFirst: Deferred<unknown>;

beforeEach(() => {
  h.calls.length = 0;
  agentBFirst = deferred();
  h.impl = (name, input) => {
    if (name !== 'agents.activity') throw new Error(`unexpected command ${name}`);
    if (input.agentId === AGENT_B) return agentBFirst.promise;
    if (input.before === 10) return Promise.resolve({ actions: [action(2, AGENT_A, 'Alpha more page')], next: 5 });
    return Promise.resolve({ actions: [action(1, AGENT_A, 'Alpha first page')], next: 10 });
  };
});

afterEach(cleanup);

const tab = (agentId: string) => <ActivityTab agentId={agentId} since={SINCE} canAudit agent={agent} onChanged={() => {}} />;

describe('activity paging belongs to one agent (#611)', () => {
  it('drops the previous agent pages and restarts the cursor for the new agent', async () => {
    const view = render(tab(AGENT_A));

    expect(await screen.findByText('Alpha first page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more actions' }));
    expect(await screen.findByText('Alpha more page')).toBeTruthy();

    view.rerender(tab(AGENT_B));

    // B's first page is pending: no row or cursor from the previous agent may remain.
    await waitFor(() => expect(screen.queryByText('Alpha first page')).toBeNull());
    expect(screen.queryByText('Alpha more page')).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading the activity ledger' })).toBeTruthy();

    await settle(agentBFirst, { actions: [action(3, AGENT_B, 'Beta first page')], next: 20 });

    expect(await screen.findByText('Beta first page')).toBeTruthy();
    expect(screen.queryByText('Alpha first page')).toBeNull();
    expect(screen.queryByText('Alpha more page')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more actions' }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'agents.activity').at(-1)?.input.before).toBe(20));
    const last = h.calls.filter((c) => c.name === 'agents.activity').at(-1)!;
    expect(last.input.agentId).toBe(AGENT_B);
  });
});
