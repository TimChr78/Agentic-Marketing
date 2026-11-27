import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspacePage from '../src/pages/settings/WorkspacePage';
import { ToastProvider } from '../src/ui';

// #1277 review: a session refresh after an approval must not overwrite a field the person is
// editing. Untouched fields still take the new server value, and a save submits only what changed.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  workspace: {
    id: 'ws_1',
    name: 'Northstar Journal',
    timeZone: 'Europe/Copenhagen',
    seedList: ['monitor@example.com'],
    serverVersion: '0.12.0',
    approvalPolicy: 'agent_changes',
    you: { type: 'user', userId: 'u1', role: 'owner', permissions: ['workspace:admin'] },
    permissionsExplained: [],
  },
}));

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({
    can: () => true,
    workspace: h.workspace,
    user: { id: 'u1', name: 'Sam Rivera', email: 'sam@example.com' },
    memberships: [],
    refresh: async () => {},
  }),
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'workspace.update')
          return { id: h.workspace.id, name: input.name ?? h.workspace.name, timeZone: input.timeZone ?? h.workspace.timeZone };
        if (name === 'workspace.setSeedList') return { seedList: input.seedList };
        throw new Error(`unexpected command ${name}`);
      }),
    },
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

const fld = (label: string) => within(document.body).getByLabelText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*?$`));

beforeEach(() => {
  h.calls = [];
  h.workspace = {
    ...h.workspace,
    name: 'Northstar Journal',
    timeZone: 'Europe/Copenhagen',
    seedList: ['monitor@example.com'],
  };
  history.replaceState(null, '', '/settings');
});

afterEach(cleanup);

describe('workspace settings survive a refresh (#1277 review)', () => {
  it('keeps a dirty field, updates an untouched one, and submits only the changed field', async () => {
    const view = render(
      <ToastProvider>
        <WorkspacePage />
      </ToastProvider>,
    );
    const name = fld('Name') as HTMLInputElement;
    expect(name.value).toBe('Northstar Journal');
    await userEvent.clear(name);
    await userEvent.type(name, 'Draft name');

    // An approval elsewhere refreshes the session while the name is being edited.
    h.workspace = { ...h.workspace, name: 'Approved name', timeZone: 'America/New_York' };
    view.rerender(
      <ToastProvider>
        <WorkspacePage />
      </ToastProvider>,
    );

    expect((fld('Name') as HTMLInputElement).value).toBe('Draft name');
    expect((fld('Time zone') as HTMLSelectElement).value).toBe('America/New_York');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.calls.find((c) => c.name === 'workspace.update')?.input).toEqual({ name: 'Draft name' }));
  });

  it('keeps an edited test-send list when the refresh sends the same addresses as a new array', async () => {
    const view = render(
      <ToastProvider>
        <WorkspacePage />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Test sends' }));
    const seed = fld('Seed list') as HTMLTextAreaElement;
    expect(seed.value).toBe('monitor@example.com');
    await userEvent.clear(seed);
    await userEvent.type(seed, 'ops@example.com');

    // A brand-only approval refresh re-reads the workspace; the list is equal but a new array.
    h.workspace = { ...h.workspace, name: 'Northstar Journal', seedList: ['monitor@example.com'] };
    view.rerender(
      <ToastProvider>
        <WorkspacePage />
      </ToastProvider>,
    );

    expect((fld('Seed list') as HTMLTextAreaElement).value).toBe('ops@example.com');
  });

  it('updates an untouched test-send list from the session', async () => {
    const view = render(
      <ToastProvider>
        <WorkspacePage />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Test sends' }));
    expect((fld('Seed list') as HTMLTextAreaElement).value).toBe('monitor@example.com');

    h.workspace = { ...h.workspace, seedList: ['ops@example.com', 'monitor@example.com'] };
    view.rerender(
      <ToastProvider>
        <WorkspacePage />
      </ToastProvider>,
    );

    expect((fld('Seed list') as HTMLTextAreaElement).value).toBe('ops@example.com\nmonitor@example.com');
  });
});
