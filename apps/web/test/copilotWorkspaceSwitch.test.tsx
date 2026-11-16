import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #952 (closed as not reproducible): a `copilot.conversation` read from workspace A used to be able
// to land after a workspace switch, because the drawer's read sequence ignores workspace changes.
// It cannot: `switchWorkspace` sets the session status to 'loading', and Root renders only the
// skeleton then, so the Shell and with it the CopilotDrawer unmount. This guard holds that in place
// by rendering the real Root (with the shell compressed to an open drawer and a switch button):
// a read still in flight when the workspace changes must not reach the drawer of the new one.

const A_ID = `cop_${'a'.repeat(32)}`;
const AGENT = { id: `agt_${'a'.repeat(32)}`, name: 'Weekday assistant', status: 'active', sponsor: { id: 'usr_1' } };

const h = vi.hoisted(() => ({
  workspaceId: null as string | null,
  /** Workspace B's session read, held so the switch visibly passes through the loading skeleton. */
  heldWorkspace: [] as ((value: unknown) => void)[],
  heldConversations: [] as { id: string; resolve: (value: unknown) => void; reject: (reason: unknown) => void }[],
  conversation: {
    id: `cop_${'a'.repeat(32)}`,
    title: 'Workspace A conversation',
    turns: 1,
    updatedAt: '2026-11-06T09:00:00.000Z',
    agentId: `agt_${'a'.repeat(32)}`,
  },
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    getWorkspaceId: () => h.workspaceId,
    setWorkspaceId: (id: string | null) => {
      h.workspaceId = id;
    },
    api: {
      call: vi.fn(async (name: string, input?: unknown) => {
        if (name === 'workspace.get') {
          const id = h.workspaceId;
          if (id === 'ws_b')
            // Held until the test has seen the loading skeleton, then answered as workspace B.
            return new Promise((resolve) => h.heldWorkspace.push(resolve));
          return {
            id: 'ws_a',
            name: 'Martech Signal',
            approvalPolicy: 'none',
            timeZone: 'UTC',
            you: { type: 'user', userId: 'usr_1', role: 'owner', permissions: ['artifacts:read'] },
          };
        }
        if (name === 'workspace.memberships') return { workspaces: [] };
        if (name === 'approvals.list') return { approvals: [], total: 0, nextCursor: null };
        if (name === 'copilot.conversations')
          // Workspace B has no conversations; A has the one whose read is in flight.
          return { conversations: h.workspaceId === 'ws_b' ? [] : [h.conversation] };
        if (name === 'agents.list') return { agents: h.workspaceId === 'ws_b' ? [] : [AGENT] };
        if (name === 'copilot.conversation')
          return new Promise((resolve, reject) => h.heldConversations.push({ id: (input as { id: string }).id, resolve, reject }));
        throw new Error(`unexpected command ${name}`);
      }),
    },
    streamFetch: vi.fn(),
  };
});

vi.mock('../src/app/theme', () => ({
  setThemeUser: vi.fn(),
  setThemePref: vi.fn(),
  getThemePref: () => 'system',
  useThemePref: () => 'system',
  useResolvedTheme: () => 'light',
}));

vi.mock('../src/features/agents/AutonomyProvider', () => ({
  AutonomyProvider: ({ children }: { children?: unknown }) => children,
  useAutonomy: () => ({ settings: null, loading: false, error: null, reload: async () => {}, save: async () => ({}) }),
}));

vi.mock('../src/app/routes', () => ({ Routes: () => null }));

// The shell itself is not what this test is about: stand in an open drawer plus the rail's
// workspace switch, both using the real session and the real CopilotDrawer.
vi.mock('../src/app/Shell', async () => {
  const React = await import('react');
  const { CopilotDrawer } = await import('../src/features/copilot/CopilotDrawer');
  const { useSession } = await import('../src/app/session');
  function ShellHarness() {
    const { workspace, switchWorkspace } = useSession();
    return React.createElement(
      'div',
      null,
      React.createElement(CopilotDrawer, { open: true, onClose: () => {} }),
      React.createElement(
        'button',
        { type: 'button', onClick: () => void switchWorkspace('ws_b') },
        `Switch from ${workspace?.id ?? 'none'}`,
      ),
    );
  }
  return { Shell: ShellHarness };
});

import { Root } from '../src/app/Root';

beforeEach(() => {
  h.workspaceId = null;
  h.heldWorkspace = [];
  h.heldConversations = [];
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ user: { id: 'usr_1', name: 'Ada', email: 'ada@example.com' } }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a workspace switch leaves no copilot state behind (#952)', () => {
  it('drops a conversation read still in flight when the workspace changes', async () => {
    render(<Root />);

    // Workspace A: open its only conversation; the read stays in flight.
    await userEvent.click(await screen.findByRole('button', { name: 'Workspace A conversation' }));
    await waitFor(() => expect(h.heldConversations).toHaveLength(1));
    expect(h.heldConversations[0].id).toBe(A_ID);

    // The switch puts the session into 'loading', and Root renders only the skeleton: the shell and
    // the drawer are gone, not hidden.
    await userEvent.click(screen.getByRole('button', { name: 'Switch from ws_a' }));
    expect(screen.getByLabelText('Loading your workspace')).toBeTruthy();
    expect(screen.queryByLabelText('Message to the copilot')).toBeNull();

    // Workspace B's session read answers; its drawer opens with nothing in it.
    await act(async () => {
      h.heldWorkspace[0]({
        id: 'ws_b',
        name: 'Second site',
        approvalPolicy: 'none',
        timeZone: 'UTC',
        you: { type: 'user', userId: 'usr_1', role: 'owner', permissions: ['artifacts:read'] },
      });
    });
    expect(await screen.findByRole('button', { name: 'Switch from ws_b' })).toBeTruthy();
    expect(await screen.findByText(/Enter sends, Shift\+Enter starts a new line/)).toBeTruthy();

    // The old read now resolves. Nothing from workspace A may appear in workspace B's drawer.
    await act(async () => {
      h.heldConversations[0].resolve({
        id: A_ID,
        title: 'Workspace A conversation',
        events: [
          { type: 'user', text: 'A workspace A question that must not appear.' },
          { type: 'text', text: 'A workspace A transcript that must not appear.' },
        ],
        usage: { totalTokens: 99 },
      });
    });

    expect(screen.queryByText('A workspace A transcript that must not appear.')).toBeNull();
    expect(screen.queryByText('A workspace A question that must not appear.')).toBeNull();
    expect(screen.queryByText(/tokens used in this session/)).toBeNull();
    expect(screen.queryByText(/Acting as the agent/)).toBeNull();
    // Not even the earlier-conversations list of A, which belonged to the previous workspace.
    expect(screen.queryByRole('button', { name: 'Workspace A conversation' })).toBeNull();
    expect(screen.getByText(/Enter sends, Shift\+Enter starts a new line/)).toBeTruthy();
  });
});
