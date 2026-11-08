import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutonomyProvider } from '../src/features/agents/AutonomyProvider';
import ApprovalPolicyPage from '../src/pages/settings/ApprovalPolicyPage';
import { ToastProvider } from '../src/ui';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  policy: 'agent_changes' as 'none' | 'agent_changes' | 'all_publishes',
  permissions: ['workspace:admin', 'artifacts:read'],
  autonomy: {
    switch: 'on' as const,
    maxLevel: {},
    allowLoops: false,
    audienceThreshold: 1000,
    limits: { changesPerDay: 500, messagesPerDay: 1000 },
    contactPressure: [],
  },
}));

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({
    can: (p: string) => h.permissions.includes(p),
    workspace: {
      id: 'ws_1',
      name: 'Northstar Journal',
      approvalPolicy: h.policy,
      you: { type: 'user', userId: 'u1', role: 'owner', permissions: h.permissions },
    },
    user: { id: 'u1', name: 'Sam Rivera', email: 'sam@example.com' },
    memberships: [],
    refresh: async () => {},
  }),
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  const respond = (name: string, input: Record<string, unknown>) => {
    switch (name) {
      case 'workspace.autonomy':
        return h.autonomy;
      case 'workspace.setAutonomy':
        return h.autonomy;
      case 'workspace.setApprovalPolicy':
        return { approvalPolicy: input.policy };
      default:
        throw new Error(`unexpected command ${name}`);
    }
  };
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        return respond(name, input);
      }),
    },
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

const view = () =>
  render(
    <ToastProvider>
      <AutonomyProvider>
        <ApprovalPolicyPage />
      </AutonomyProvider>
    </ToastProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  h.calls = [];
  h.policy = 'agent_changes';
  history.replaceState(null, '', '/settings/approval-policy');
});

describe('Approval policy and agent autonomy (#527)', () => {
  it('keeps one template header, the policy choices, the save action and the read-only agent rule', async () => {
    view();
    expect(screen.getByRole('heading', { level: 1, name: 'Approval policy and agent autonomy' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Review agent changes/ })).toHaveProperty('checked', true);
    expect(screen.getByText(/Agents can never approve a change, whatever the policy/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save policy' })).toHaveProperty('disabled', true);

    await userEvent.click(screen.getByRole('radio', { name: /Four-eyes/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(h.calls.find((c) => c.name === 'workspace.setApprovalPolicy')?.input).toEqual({ policy: 'all_publishes' }));
  });

  it('confirms before relaxing the policy', async () => {
    h.policy = 'all_publishes';
    view();
    await userEvent.click(screen.getByRole('radio', { name: /No review/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/goes live at once/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Change policy' }));
    await waitFor(() => expect(h.calls.find((c) => c.name === 'workspace.setApprovalPolicy')?.input).toEqual({ policy: 'none' }));
  });

  it('reuses the shared autonomy read and controls on the second tab', async () => {
    view();
    await waitFor(() => expect(h.calls.some((c) => c.name === 'workspace.autonomy')).toBe(true));
    await userEvent.click(screen.getByRole('tab', { name: 'Agent autonomy' }));
    expect(await screen.findByRole('button', { name: 'Save autonomy' })).toBeTruthy();
    expect(screen.getByText(/These controls apply to every agent/)).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'workspace.autonomy')).toHaveLength(1);
  });
});
