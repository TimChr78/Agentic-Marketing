import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '../src/app/session';
import { CreateTokenDrawer } from '../src/features/tokens/CreateTokenDrawer';
import { ToastProvider } from '../src/ui';

const { call, forWorkspace } = vi.hoisted(() => {
  const call = vi.fn(async (..._args: unknown[]) => ({
    id: 'tok_00000000000000000000000000000000',
    workspaceId: 'b',
    workspaceName: 'Brand B',
    name: 'Hermes',
    userId: 'u1',
    ownerName: 'Owner',
    tokenHint: 'amk_1234…abcd',
    scopes: ['artifacts:read'],
    createdAt: new Date().toISOString(),
    expiresAt: null,
    lastUsedAt: null,
    revoked: false,
    token: 'amk_secret',
  }));
  return { call, forWorkspace: vi.fn((_id: string) => ({ call })) };
});

vi.mock('../src/app/api', () => ({
  api: { call },
  apiForWorkspace: (id: string) => forWorkspace(id),
  errText: (e: unknown) => String(e),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const memberships: Membership[] = [
  { id: 'a', name: 'Brand A', role: 'owner', brand: { siteName: 'Brand A', logoUrl: null, primaryDomain: null } },
  { id: 'b', name: 'Brand B', role: 'viewer', brand: { siteName: 'Brand B', logoUrl: null, primaryDomain: 'brand-b.example' } },
];

const renderDrawer = (onCreated = vi.fn()) =>
  render(
    <ToastProvider>
      <CreateTokenDrawer
        allowed={['artifacts:read', 'artifacts:write']}
        memberships={memberships}
        currentWorkspaceId="a"
        onClose={vi.fn()}
        onCreated={onCreated}
      />
    </ToastProvider>,
  );

describe('token brand picker (#187)', () => {
  it('offers every brand whose role can grant the chosen scopes', async () => {
    renderDrawer();
    const select = screen.getByLabelText('Brand') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Brand A (owner)', 'Brand B (viewer)']);

    await userEvent.click(screen.getByRole('checkbox', { name: /Draft and edit/ }));
    await waitFor(() => expect([...select.options].map((o) => o.text)).toEqual(['Brand A (owner)']));
  });

  it('creates the token in the chosen brand through that brand’s client', async () => {
    const onCreated = vi.fn();
    renderDrawer(onCreated);
    await userEvent.type(screen.getByRole('textbox', { name: /Name/ }), 'Hermes');
    await userEvent.selectOptions(screen.getByLabelText('Brand'), 'b');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => expect(forWorkspace).toHaveBeenCalledWith('b'));
    expect(call).toHaveBeenCalledWith('apiTokens.create', expect.objectContaining({ name: 'Hermes', scopes: ['artifacts:read'] }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ name: 'Hermes', token: 'amk_secret', workspaceName: 'Brand B' }));
  });
});
