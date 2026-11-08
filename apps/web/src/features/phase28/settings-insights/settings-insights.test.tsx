import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProvidersPage from '../../../pages/settings/ProvidersPage';
import { ToastProvider } from '../../../ui';
import { TokensCard } from '../../tokens/TokensCard';

// Phase 28 (#560) S acceptance: token status stays visible at 390 px, strict-input guidance is
// bounded, and a partial provider read names only the channels that failed. Rendering the real
// components keeps this a presentation check: no transport, no fixture server.

const h = vi.hoisted(() => ({
  calls: [] as string[],
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
  warnings: { clients: [] as unknown[], sinceDays: 30, strictInputs: false, safeToEnableStrict: false },
  email: [
    {
      id: 'epr_1',
      name: 'Newsletter delivery',
      adapter: 'postmark',
      config: { messageStream: 'broadcast' },
      fromEmail: 'news@example.com',
      fromName: 'Northstar Journal',
      replyTo: null,
      useFor: ['marketing'],
      enabled: true,
      hasCredentials: true,
      tracking: 'configurable',
      trackingNote: 'Postmark tracks opens and clicks only when you enable it in the message stream.',
    },
  ],
  adapters: [
    {
      id: 'postmark',
      label: 'Postmark',
      config: { type: 'object', properties: { messageStream: { type: 'string' } }, required: ['messageStream'] },
      secrets: { type: 'object', properties: { serverToken: { type: 'string' } }, required: ['serverToken'] },
      tracking: 'configurable',
      trackingNote: 'Postmark tracks opens and clicks only when you enable it in the message stream.',
    },
  ],
  push: [
    {
      id: 'psh_1',
      name: 'Web push',
      adapter: 'webpush',
      config: { subject: 'mailto:ops@example.com', publicKey: 'BPublicKey0123' },
      useFor: ['marketing'],
      enabled: true,
    },
  ],
  pushFails: false,
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  const respond = (name: string) => {
    switch (name) {
      case 'apiTokens.list':
        return { tokens: [h.token] };
      case 'system.inputWarnings':
        return h.warnings;
      case 'emailProviders.list':
        return { providers: h.email, adapters: h.adapters, warnings: [] };
      case 'smsProviders.list':
        return { providers: [] };
      case 'pushProviders.list':
        if (h.pushFails) throw new Error('push unavailable');
        return { providers: h.push };
      case 'aiProviders.list':
        return { providers: [] };
      default:
        throw new Error(`unexpected command ${name}`);
    }
  };
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        return respond(name);
      }),
    },
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

vi.mock('../../../app/session', () => {
  const permissions = ['workspace:admin', 'artifacts:read'];
  const workspace = {
    id: 'ws_1',
    name: 'Northstar Journal',
    timeZone: 'UTC',
    serverVersion: '0.14.0',
    seedList: [],
    approvalPolicy: 'agent_changes',
    you: { type: 'user', userId: 'u1', role: 'owner', permissions },
    permissionsExplained: [],
  };
  const value = {
    can: (p: string) => permissions.includes(p),
    workspace,
    user: { id: 'u1', name: 'Sam Rivera', email: 'sam@example.com' },
    memberships: [{ id: 'ws_1', name: 'Northstar Journal', role: 'owner', brand: {} }],
    refresh: async () => {},
  };
  return { useSession: () => value, useWorkspace: () => value };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  h.calls = [];
  h.warnings = { clients: [], sinceDays: 30, strictInputs: false, safeToEnableStrict: false };
  h.pushFails = false;
});

const renderTokens = () =>
  render(
    <ToastProvider>
      <TokensCard />
    </ToastProvider>,
  );

const renderProviders = () =>
  render(
    <ToastProvider>
      <ProvidersPage />
    </ToastProvider>,
  );

describe('API token row (S1)', () => {
  it('keeps the token status beside its name on a phone and in its own column from md up', async () => {
    renderTokens();
    const table = await screen.findByRole('table', { name: 'API tokens' });
    const name = within(table).getByText('n8n reporting');
    const nameCell = name.closest('td');
    expect(nameCell).not.toBeNull();
    // The status travels with the name at 390 px; the separate status column is desktop-only.
    expect(within(nameCell as HTMLElement).getByText('Active')).toBeTruthy();
    const statusHeader = within(table).getByRole('columnheader', { name: 'Status' });
    expect(statusHeader.className).toContain('hidden');
    expect(statusHeader.className).toContain('md:table-cell');
    // Brand, owner and last use remain in the row detail, not the phone's first view.
    for (const header of ['Brand', 'Owner', 'Last used']) {
      expect(within(table).getByRole('columnheader', { name: header }).className).toContain('hidden');
    }
  });
});

describe('strict input guidance (S2)', () => {
  it('states the observation and its limit without an unqualified safety claim', async () => {
    h.warnings = { clients: [], sinceDays: 30, strictInputs: false, safeToEnableStrict: true };
    renderTokens();

    expect(await screen.findByText(/No unknown input keys recorded in the last 7 days/)).toBeTruthy();
    expect(screen.getByText(/Review your clients before enabling strict input validation/)).toBeTruthy();
    expect(screen.queryByText(/safe to set/i)).toBeNull();
    // The configuration identifier stays in explicitly labelled technical setup.
    const summary = screen.getByText('Technical setup');
    expect(summary.closest('details')).not.toBeNull();
    expect(screen.getByText('STRICT_INPUTS=true')).toBeTruthy();
  });
});

describe('provider reads (S3)', () => {
  it('names only the channels that failed and keeps the successful ones usable', async () => {
    h.pushFails = true;
    renderProviders();

    expect(await screen.findByText('Some provider channels couldn’t load')).toBeTruthy();
    expect(screen.getByText(/Push could not be read/)).toBeTruthy();
    expect(screen.getByText(/The other 3 channels loaded and remain usable/)).toBeTruthy();
    expect(screen.queryByText('Couldn’t load providers')).toBeNull();
    expect((await screen.findAllByText('Newsletter delivery')).length).toBeGreaterThan(0);
    await waitFor(() => expect(h.calls).toEqual(expect.arrayContaining(['pushProviders.list'])));
  });
});
