import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreferencesPage from '../src/pages/settings/PreferencesPage';
import SecretsPage from '../src/pages/settings/SecretsPage';
import UsersPage from '../src/pages/settings/UsersPage';
import WorkspacePage from '../src/pages/settings/WorkspacePage';
import { ToastProvider } from '../src/ui';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  setTheme: vi.fn(),
  permissions: ['workspace:admin', 'artifacts:read', 'secrets:read', 'secrets:write'],
  user: { id: 'u1', name: 'Sam Rivera', email: 'sam@example.com' },
  workspace: {
    id: 'ws_1',
    name: 'Northstar Journal',
    timeZone: 'Europe/Copenhagen',
    seedList: ['monitor@example.com'],
    serverVersion: '0.12.0',
    approvalPolicy: 'agent_changes',
    you: { type: 'user', userId: 'u1', role: 'owner', permissions: ['workspace:admin'] },
    permissionsExplained: [
      { permission: 'artifacts:write', meaning: 'Create and edit drafts.' },
      { permission: 'workspace:admin', meaning: 'Manage workspace settings.' },
    ],
  },
  secrets: [
    {
      name: 'delivery.credential',
      updatedAt: '2026-11-02T09:00:00Z',
      updatedBy: 'u1',
      updatedByName: 'Sam Rivera',
    },
  ],
  members: [
    { userId: 'u1', name: 'Sam Rivera', email: 'sam@example.com', role: 'owner', since: '2026-10-02T09:00:00Z' },
    { userId: 'u2', name: 'Alex Chen', email: 'alex@example.com', role: 'viewer', since: '2026-11-01T09:00:00Z' },
  ],
  invitations: [
    {
      id: 'inv_1',
      email: 'new@example.com',
      role: 'marketer',
      status: 'pending',
      createdAt: '2026-11-05T09:00:00Z',
      expiresAt: '2026-11-12T09:00:00Z',
    },
  ],
}));

vi.mock('../src/app/theme', () => ({
  useThemePref: () => 'system',
  setThemePref: h.setTheme,
}));

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({
    can: (p: string) => h.permissions.includes(p),
    workspace: h.workspace,
    user: h.user,
    memberships: [],
    refresh: async () => {},
  }),
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  const respond = (name: string, input: Record<string, unknown>) => {
    switch (name) {
      case 'workspace.update':
        return { ...h.workspace, ...input };
      case 'workspace.setSeedList':
        return { ...h.workspace, seedList: input.seedList };
      case 'secrets.list':
        return { secrets: h.secrets };
      case 'secrets.set':
      case 'secrets.delete':
        return {};
      case 'members.list':
        return { members: h.members };
      case 'invitations.list':
        return { invitations: h.invitations };
      case 'sso.list':
        return { providers: [] };
      case 'scim.status':
        return { configured: false, enabled: false, users: 0, groups: 0, defaultRole: 'marketer' };
      case 'members.setRole':
        return { ok: true };
      case 'members.remove':
        return { ok: true };
      case 'members.invite':
        return { acceptPath: '/invite/abc123', expiresAt: '2026-11-15T09:00:00Z' };
      case 'invitations.revoke':
        return { ok: true };
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

const fld = (scope: HTMLElement, label: string) =>
  within(scope).getByLabelText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*?$`));

const view = (page: ReactNode) => render(<ToastProvider>{page}</ToastProvider>);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  h.calls = [];
  history.replaceState(null, '', '/settings');
});

describe('Workspace settings (#527)', () => {
  it('keeps General and Test sends as independent saves and keeps input after a failed save', async () => {
    view(<WorkspacePage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeTruthy();
    const name = fld(document.body, 'Name') as HTMLInputElement;
    expect(name.value).toBe('Northstar Journal');
    await userEvent.clear(name);
    await userEvent.type(name, 'Northstar Daily');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(h.calls.find((c) => c.name === 'workspace.update')?.input).toMatchObject({
        name: 'Northstar Daily',
        timeZone: 'Europe/Copenhagen',
      }),
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Test sends' }));
    const seed = fld(document.body, 'Seed list') as HTMLTextAreaElement;
    expect(seed.value).toBe('monitor@example.com');
    await userEvent.clear(seed);
    await userEvent.type(seed, 'not-an-address');
    await userEvent.click(screen.getByRole('button', { name: 'Save test sends' }));
    expect(await screen.findByText(/is not an e-mail address/)).toBeTruthy();
    expect(h.calls.some((c) => c.name === 'workspace.setSeedList')).toBe(false);
    expect((fld(document.body, 'Seed list') as HTMLTextAreaElement).value).toBe('not-an-address');

    await userEvent.clear(fld(document.body, 'Seed list'));
    await userEvent.type(fld(document.body, 'Seed list'), 'Ops@Example.com\nmonitor@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save test sends' }));
    await waitFor(() =>
      expect(h.calls.find((c) => c.name === 'workspace.setSeedList')?.input).toEqual({
        seedList: ['ops@example.com', 'monitor@example.com'],
      }),
    );
  });
});

describe('Secrets (#527)', () => {
  it('lists names and metadata, never a value, and stores a write-only value', async () => {
    view(<SecretsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Secrets' })).toBeTruthy();
    expect((await screen.findAllByText('delivery.credential')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Sam Rivera')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/secret value/)).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: 'Add secret' })[0]);
    const drawer = await screen.findByRole('dialog', { name: 'Add secret' });
    await userEvent.type(fld(drawer, 'Name'), 'llm.anthropic.api_key');
    const value = fld(drawer, 'Value') as HTMLInputElement;
    expect(value.type).toBe('password');
    await userEvent.type(value, 'sk-live-secret');
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'Show while typing' }));
    expect((fld(drawer, 'Value') as HTMLInputElement).type).toBe('text');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add secret' }));

    await waitFor(() =>
      expect(h.calls.find((c) => c.name === 'secrets.set')?.input).toEqual({
        name: 'llm.anthropic.api_key',
        value: 'sk-live-secret',
      }),
    );
    expect(h.calls.some((c) => c.name === 'secrets.get')).toBe(false);
    expect(screen.queryByText('sk-live-secret')).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: 'Rotate' })[0]);
    const rotate = await screen.findByRole('dialog', { name: /Replace the value of “delivery.credential”/ });
    expect((fld(rotate, 'Name') as HTMLInputElement).readOnly).toBe(true);
    expect(within(rotate).getByText(/Values are encrypted and never shown again|only the value/)).toBeTruthy();
  });
});

describe('Users and roles (#527)', () => {
  it('keeps own and last-owner protections and shows the once-only invitation link without e-mail wording', async () => {
    view(<UsersPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Users and roles' })).toBeTruthy();
    const ownRole = (await screen.findAllByLabelText('Role for Sam Rivera'))[0] as HTMLSelectElement;
    expect(ownRole.disabled).toBe(true);
    expect((screen.getAllByRole('button', { name: 'Remove Sam Rivera' })[0] as HTMLButtonElement).disabled).toBe(true);

    const roles = (await screen.findAllByLabelText('Role for Alex Chen'))[0] as HTMLSelectElement;
    await userEvent.selectOptions(roles, 'marketer');
    await waitFor(() => expect(h.calls.find((c) => c.name === 'members.setRole')?.input).toEqual({ userId: 'u2', role: 'marketer' }));

    expect(await screen.findByText(/No e-mail is sent; share the link yourself/)).toBeTruthy();
    expect(screen.getByText(/Created .* expires/)).toBeTruthy();

    await userEvent.click(screen.getAllByRole('button', { name: 'Invite person' })[0]);
    const drawer = await screen.findByRole('dialog', { name: 'Invite person' });
    await userEvent.type(fld(drawer, 'E-mail address'), 'new@example.com');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Create invitation' }));
    const created = await screen.findByText('Invitation created');
    expect(created).toBeTruthy();
    expect(within(drawer).getByDisplayValue(/\/invite\/abc123/)).toBeTruthy();
    expect(within(drawer).getByText(/No e-mail is sent/)).toBeTruthy();
  });
});

describe('Preferences (#527)', () => {
  it('keeps the device theme and explains permissions in human words first', async () => {
    view(<PreferencesPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Preferences' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /System/ })).toHaveProperty('checked', true);
    await userEvent.click(screen.getByRole('radio', { name: /Dark/ }));
    expect(h.setTheme).toHaveBeenCalledWith('dark');

    await userEvent.click(screen.getByRole('tab', { name: 'What you can do' }));
    expect(screen.getByText('Create and edit drafts.')).toBeTruthy();
    const code = screen.getByText('artifacts:write');
    expect(code.closest('details')).toBeTruthy();
  });
});
