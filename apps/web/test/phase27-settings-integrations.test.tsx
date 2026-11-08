import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IntegrationsPage from '../src/pages/settings/IntegrationsPage';
import { ToastProvider } from '../src/ui';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  token: {
    id: 'tok_1',
    name: 'n8n reporting',
    tokenHint: 'amk_1234…abcd',
    workspaceId: 'ws_1',
    workspaceName: 'Northstar Journal',
    userId: 'u1',
    ownerName: 'Sam Rivera',
    owner: { id: 'u1', name: 'Sam Rivera', email: 'sam@example.com' },
    scopes: ['artifacts:read'],
    createdAt: '2026-10-01T09:00:00Z',
    expiresAt: '2026-12-02T09:00:00Z',
    lastUsedAt: '2026-11-06T09:00:00Z',
    revoked: false,
    history: [],
  },
}));

vi.mock('../src/app/session', () => {
  const permissions = ['workspace:admin', 'artifacts:read', 'secrets:read', 'secrets:write'];
  const workspace = {
    id: 'ws_1',
    name: 'Northstar Journal',
    you: { type: 'user', userId: 'u1', role: 'owner', permissions },
    permissionsExplained: [],
  };
  return {
    useSession: () => ({
      can: (p: string) => permissions.includes(p),
      workspace,
      user: { id: 'u1', name: 'Sam Rivera', email: 'sam@example.com' },
    }),
    useWorkspace: () => ({
      can: (p: string) => permissions.includes(p),
      workspace,
      user: { id: 'u1', name: 'Sam Rivera', email: 'sam@example.com' },
      memberships: [{ id: 'ws_1', name: 'Northstar Journal', role: 'owner', brand: {} }],
      refresh: async () => {},
    }),
  };
});

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  const respond = (name: string) => {
    switch (name) {
      case 'apiTokens.list':
        return { tokens: [h.token] };
      case 'apiTokens.get':
        return h.token;
      case 'system.inputWarnings':
        return { clients: [], sinceDays: 30, strictInputs: true, safeToEnableStrict: false };
      case 'sources.list':
        return { sources: [] };
      case 'webhooks.list':
        return { endpoints: [] };
      case 'deliveries.list':
        return { deliveries: [] };
      case 'connectors.list':
        return { connectors: [] };
      case 'connections.list':
        return { connections: [] };
      case 'purposes.list':
        return { source: 'published', purposes: [] };
      default:
        throw new Error(`unexpected command ${name}`);
    }
  };
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        return respond(name);
      }),
    },
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

const names = () => h.calls.map((c) => c.name);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  h.calls = [];
});

const renderPage = (params: Record<string, string> = {}) =>
  render(
    <ToastProvider>
      <IntegrationsPage params={params} />
    </ToastProvider>,
  );

describe('Integrations sections (#527)', () => {
  it('mounts only the API tokens section and reads exactly its two commands', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Integrations and API tokens' })).toBeTruthy();
    await waitFor(() => expect(names()).toEqual(expect.arrayContaining(['apiTokens.list', 'system.inputWarnings'])));
    expect(names()).toHaveLength(2);
    expect(names()).not.toContain('sources.list');
    expect(names()).not.toContain('connections.list');
    expect(screen.getByText('n8n reporting')).toBeTruthy();
  });

  it('loads only the section that is selected, then only that section again on refresh', async () => {
    renderPage();
    await screen.findByText('n8n reporting');

    await userEvent.click(screen.getByRole('tab', { name: 'Webhooks' }));
    await waitFor(() => expect(names()).toContain('deliveries.list'));
    expect(names()).toContain('webhooks.list');
    expect(names()).not.toContain('sources.list');
    expect(names()).not.toContain('connectors.list');

    await userEvent.click(screen.getByRole('tab', { name: 'Event sources' }));
    await waitFor(() => expect(names()).toContain('sources.list'));

    await userEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    await waitFor(() => expect(names()).toContain('connectors.list'));
    expect(names()).toContain('connections.list');
  });

  it('keeps the Connect an agent instructions without a read', async () => {
    renderPage();
    await screen.findByText('n8n reporting');
    const before = names().length;
    await userEvent.click(screen.getByRole('tab', { name: 'Connect an agent' }));
    expect(names()).toHaveLength(before);
    expect(screen.getByText(/Clients that support OAuth/)).toBeTruthy();
    expect(screen.getByText(/Authorization: Bearer amk_/)).toBeTruthy();
  });

  it('opens a token deep link inside the API tokens section with one exact read', async () => {
    renderPage({ id: 'tok_1' });
    const drawer = await screen.findByRole('dialog', { name: 'n8n reporting' });
    expect(within(drawer).getByText('Sam Rivera (sam@example.com)')).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'apiTokens.get')).toHaveLength(1);
    expect(h.calls.find((c) => c.name === 'apiTokens.get')?.input).toEqual({ id: 'tok_1' });
    expect(screen.getByRole('tab', { name: 'API tokens' }).getAttribute('aria-selected')).toBe('true');
  });
});
