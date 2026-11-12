import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #613: the footer reports the tokens of the chat it is attached to. A new chat and opening an
// earlier conversation both start from zero, so the previous conversation's total is never shown
// as this one's.

const h = vi.hoisted(() => ({
  conversations: [{ id: `cop_${'a'.repeat(32)}`, title: 'Earlier chat', turns: 1, updatedAt: '2026-11-06T09:00:00.000Z', agentId: null }],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'copilot.conversations') return { conversations: h.conversations };
        if (name === 'copilot.conversation')
          return {
            id: h.conversations[0].id,
            title: h.conversations[0].title,
            events: [
              { type: 'user', text: 'What is in this workspace?' },
              { type: 'text', text: 'A workspace with sample data.' },
            ],
          };
        if (name === 'agents.list') return { agents: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
    streamFetch: vi.fn(
      async () =>
        new Response(
          [
            JSON.stringify({ type: 'conversation', id: `cop_${'b'.repeat(32)}`, title: 'New chat' }),
            JSON.stringify({
              type: 'done',
              conversationId: `cop_${'b'.repeat(32)}`,
              usage: { inputTokens: 7, outputTokens: 5 },
            }),
            '',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
    ),
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

beforeEach(() => {
  h.conversations = [
    { id: `cop_${'a'.repeat(32)}`, title: 'Earlier chat', turns: 1, updatedAt: '2026-11-06T09:00:00.000Z', agentId: null },
  ];
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const renderDrawer = () => render(<CopilotDrawer open onClose={() => {}} />);

describe('copilot token counter (#613)', () => {
  it('resets on New chat and when another conversation is opened', async () => {
    renderDrawer();

    // One completed turn reports only this chat's tokens.
    await userEvent.click(await screen.findByRole('button', { name: 'What is in this workspace?' }));
    expect(await screen.findByText('12 tokens used in this session')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText(/tokens used/)).toBeNull();
    expect(screen.getByText(/Enter sends, Shift\+Enter starts a new line/)).toBeTruthy();

    // A second turn in the new chat counts only that chat, then opening an earlier conversation
    // starts the counter over for the conversation on screen.
    await userEvent.click(screen.getByRole('button', { name: 'What is in this workspace?' }));
    expect(await screen.findByText('12 tokens used in this session')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Earlier chat' }));

    await waitFor(() => expect(screen.queryByText(/tokens used/)).toBeNull());
    expect(screen.getByText(/Enter sends, Shift\+Enter starts a new line/)).toBeTruthy();
    expect(await screen.findByText('A workspace with sample data.')).toBeTruthy();
  });
});
