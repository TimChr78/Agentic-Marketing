import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IntegrationsPage from '../src/pages/settings/IntegrationsPage';
import { ToastProvider } from '../src/ui';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  sources: [
    {
      id: 'src_1',
      name: 'Website',
      kind: 'browser',
      allowedOrigins: ['https://example.com'],
      requiredPurpose: 'analytics',
      enabled: true,
      keyHint: 'wrk_…abcd',
      writeKey: 'wrk_public',
    },
  ],
  endpoints: [
    {
      id: 'wh_1',
      name: 'Order events',
      url: 'https://hooks.example.com/am',
      events: ['order.completed'],
      purpose: 'analytics',
      enabled: true,
    },
  ],
  deliveries: [
    {
      id: 'dlv_1',
      kind: 'webhook',
      targetId: 'wh_1',
      status: 'failed',
      attempts: 3,
      statusCode: 500,
      error: 'Connection refused',
      createdAt: '2026-11-07T09:00:00Z',
      payload: { type: 'order.completed' },
    },
  ],
  connectors: [
    { id: 'http', label: 'HTTP API', description: 'Call your own API.', auth: 'oauth2', inbound: false, settings: {}, secrets: {} },
  ],
  connections: [
    {
      id: 'cn_1',
      name: 'Shopify',
      connector: 'http',
      enabled: true,
      hasSecrets: true,
      settings: {},
      inbound: false,
      oauth: { status: 'error', error: 'Access denied by the provider' },
    },
  ],
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
        return { sources: h.sources };
      case 'webhooks.list':
        return { endpoints: h.endpoints };
      case 'deliveries.list':
        return { deliveries: h.deliveries };
      case 'connectors.list':
        return { connectors: h.connectors };
      case 'connections.list':
        return { connections: h.connections };
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

  it('keeps the token create drawer fields and the section name', async () => {
    renderPage();
    await screen.findByText('n8n reporting');
    await userEvent.click(screen.getAllByRole('button', { name: 'Create token' })[0]);
    const drawer = await screen.findByRole('dialog', { name: 'Create an API token' });
    for (const label of ['Name', 'Brand', 'Expires']) expect(within(drawer).getByLabelText(new RegExp(`^${label}\\*?$`))).toBeTruthy();
    expect(within(drawer).getByText('Scopes')).toBeTruthy();
  });

  it('keeps the event source origins and consent rules in the add drawer', async () => {
    renderPage();
    await screen.findByText('n8n reporting');
    await userEvent.click(screen.getByRole('tab', { name: 'Event sources' }));
    expect(await screen.findByText('https://example.com')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Add source' })[0]);
    const drawer = await screen.findByRole('dialog', { name: 'Add an event source' });
    expect(within(drawer).getByRole('radio', { name: /Website/ })).toBeTruthy();
    expect(within(drawer).getByRole('radio', { name: /Server/ })).toBeTruthy();
    for (const label of ['Name', 'Allowed sites', 'Keep events only with consent for'])
      expect(within(drawer).getByLabelText(new RegExp(`^${label}\\*?$`))).toBeTruthy();
  });

  it('keeps webhook endpoints, visible delivery errors, retry and the endpoint drawer', async () => {
    renderPage();
    await screen.findByText('n8n reporting');
    await userEvent.click(screen.getByRole('tab', { name: 'Webhooks' }));
    expect((await screen.findAllByText('Order events')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getByText('Connection refused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Add endpoint' })[0]);
    const drawer = await screen.findByRole('dialog', { name: 'Add endpoint' });
    for (const label of ['Name', 'Endpoint URL', 'Events', 'Purpose'])
      expect(within(drawer).getByLabelText(new RegExp(`^${label}\\*?$`))).toBeTruthy();
    expect(within(drawer).getByText(/signing secret is shown once/)).toBeTruthy();
  });

  it('keeps complete connection fields and an authorization failure with recovery', async () => {
    renderPage();
    await screen.findByText('n8n reporting');
    await userEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    expect(await screen.findByText('Shopify')).toBeTruthy();
    expect(screen.getByText('Authorization failed')).toBeTruthy();
    expect(screen.getByText('Access denied by the provider')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Add connection' })[0]);
    const drawer = await screen.findByRole('dialog', { name: 'Add connection' });
    expect(within(drawer).getByLabelText(/^Connector/)).toBeTruthy();
    expect(within(drawer).getByLabelText(/^Name/)).toBeTruthy();
    expect(within(drawer).getByText('Settings')).toBeTruthy();
    expect(within(drawer).getByText('Credentials')).toBeTruthy();
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
