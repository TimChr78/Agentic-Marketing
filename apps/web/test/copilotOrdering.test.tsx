import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #918: opening an earlier conversation is a read that can overtake another one. Only the
// last-clicked conversation may commit its transcript, agent and token counter, and a read that
// was in flight when the person moved on must be dropped rather than replace what they see.

const h = vi.hoisted(() => {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  const conversation = (id: string, title: string) => ({ id, title, turns: 1, updatedAt: '2026-11-06T09:00:00.000Z', agentId: null });
  return {
    pending,
    conversation,
    conversations: [] as { id: string; title: string; turns: number; updatedAt: string; agentId: null }[],
  };
});

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input?: unknown) => {
        if (name === 'copilot.conversations') return { conversations: h.conversations };
        if (name === 'agents.list') return { agents: [] };
        if (name === 'copilot.conversation')
          return new Promise((resolve, reject) => h.pending.set((input as { id: string }).id, { resolve, reject }));
        throw new Error(`unexpected command ${name}`);
      }),
    },
    streamFetch: vi.fn(),
  };
});

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_1' } }),
}));

vi.mock('../src/app/capabilities', () => ({
  useCapabilities: () => ({ mutations: true, copilot: true, reason: null }),
  useCopilotAvailable: () => ({ available: true, reason: null }),
}));

import { CopilotDrawer } from '../src/features/copilot/CopilotDrawer';

const A = h.conversation(`cop_${'a'.repeat(32)}`, 'Conversation A');
const B = h.conversation(`cop_${'b'.repeat(32)}`, 'Conversation B');

beforeEach(() => {
  h.pending.clear();
  h.conversations = [A, B];
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const answer = (person: 'A' | 'B', text: string, totalTokens: number, id: string) => ({
  ...(person === 'A' ? A : B),
  events: [{ type: 'text', text }],
  usage: { totalTokens },
  id,
});

describe('copilot conversation switching keeps the latest click (#918)', () => {
  it('drops a slower earlier read, so the last-clicked conversation stays on screen', async () => {
    render(<CopilotDrawer open onClose={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Conversation A' }));
    await userEvent.click(screen.getByRole('button', { name: 'Conversation B' }));

    // B is fast; A is still pending.
    h.pending.get(B.id)!.resolve(answer('B', 'B answer', 50, B.id));
    expect(await screen.findByText('B answer')).toBeTruthy();
    expect(screen.getByText('50 tokens used in this session')).toBeTruthy();

    // A lands afterwards and must change nothing.
    await act(async () => {
      h.pending.get(A.id)!.resolve(answer('A', 'A answer', 99, A.id));
    });
    expect(screen.queryByText('A answer')).toBeNull();
    expect(screen.getByText('B answer')).toBeTruthy();
    expect(screen.getByText('50 tokens used in this session')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conversation B' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Conversation A' }).getAttribute('aria-current')).toBeNull();
  });

  it('drops a late error from a conversation the person moved away from', async () => {
    render(<CopilotDrawer open onClose={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Conversation A' }));
    await userEvent.click(screen.getByRole('button', { name: 'Conversation B' }));
    h.pending.get(B.id)!.resolve(answer('B', 'B answer', 50, B.id));
    expect(await screen.findByText('B answer')).toBeTruthy();

    await act(async () => {
      h.pending.get(A.id)!.reject(new Error('The earlier conversation failed to load'));
    });
    expect(screen.queryByText('The earlier conversation failed to load')).toBeNull();
    expect(screen.getByText('B answer')).toBeTruthy();
  });

  it('drops a read that was in flight when the person started a new chat', async () => {
    render(<CopilotDrawer open onClose={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Conversation B' }));
    h.pending.get(B.id)!.resolve(answer('B', 'B answer', 50, B.id));
    expect(await screen.findByText('B answer')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Conversation A' }));
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));

    await act(async () => {
      h.pending.get(A.id)!.resolve(answer('A', 'A answer', 99, A.id));
    });
    expect(screen.queryByText('A answer')).toBeNull();
    expect(screen.getByText(/Enter sends, Shift\+Enter starts a new line/)).toBeTruthy();
  });
});
