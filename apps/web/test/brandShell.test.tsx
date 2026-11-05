import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #190 and #180: the switcher shows the brand's name, logo and primary domain; New brand is offered
// only to a person who owns a brand; the desktop rail collapses and survives a reload per device.

const { session } = vi.hoisted(() => ({
  session: {
    status: 'ready',
    user: { id: 'u1', name: 'Alex', email: 'alex@example.com' },
    workspace: {
      id: 'a',
      name: 'Martech Signal',
      approvalPolicy: 'none',
      timeZone: 'UTC',
      seedList: [],
      domains: [],
      linksUrl: 'https://links.martechsignal.com',
      brand: { siteName: 'Martech Signal', logoUrl: 'https://cdn.example/martech.svg', primaryDomain: 'links.martechsignal.com' },
      serverVersion: '0.8.0',
      you: { type: 'user', userId: 'u1', role: 'owner', permissions: ['artifacts:read', 'workspace:admin'] },
      permissionsExplained: [],
    },
    memberships: [
      {
        id: 'a',
        name: 'Martech Signal',
        role: 'owner',
        brand: { siteName: 'Martech Signal', logoUrl: 'https://cdn.example/martech.svg', primaryDomain: 'links.martechsignal.com' },
      },
      {
        id: 'b',
        name: 'Second site',
        role: 'admin',
        brand: { siteName: 'Second site', logoUrl: null, primaryDomain: 'second.example' },
      },
    ],
    can: () => true,
    refresh: async () => {},
    switchWorkspace: vi.fn(async () => {}),
    signOut: async () => {},
    pending: 3,
    refreshPending: () => {},
  },
}));

vi.mock('../src/app/session', () => ({ useSession: () => session }));
vi.mock('../src/features/agents/AutonomyProvider', () => ({
  useAutonomy: () => ({ settings: null, loading: false, error: null, reload: async () => {}, save: async () => ({}) }),
}));
vi.mock('../src/app/SearchPalette', () => ({ SearchPalette: () => null }));
vi.mock('../src/features/copilot/CopilotDrawer', () => ({ CopilotDrawer: () => null }));

// jsdom has no matchMedia; theme.ts reads it at module load.
if (!window.matchMedia)
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

const { Shell, WorkspaceSwitcher } = await import('../src/app/Shell');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('am.theme.user', 'u1');
});

afterEach(() => cleanup());

describe('brand-aware shell (#190)', () => {
  it('shows the brand name, logo and primary domain in the switcher', () => {
    const { container } = render(<WorkspaceSwitcher />);
    const trigger = screen.getByRole('button', { name: /Brand: Martech Signal \(links\.martechsignal\.com\)/ });
    expect(trigger).toBeTruthy();
    expect(screen.getByText('links.martechsignal.com')).toBeTruthy();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/martech.svg');
  });

  it('lists every brand with its domain and offers New brand to an owner', async () => {
    render(<WorkspaceSwitcher />);
    await userEvent.click(screen.getByRole('button', { name: /Switch brand/ }));
    expect(screen.getByRole('menuitem', { name: /Martech Signal/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Second site/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Second site/ }).textContent).toContain('second.example');
    expect(screen.getByRole('menuitem', { name: 'New brand…' })).toBeTruthy();
  });

  it('hides New brand from people who own no brand', async () => {
    const original = session.memberships;
    const originalWorkspace = session.workspace;
    session.memberships = [
      { ...original[0], role: 'admin' },
      { ...original[1], role: 'viewer' },
    ];
    session.workspace = { ...originalWorkspace, you: { ...originalWorkspace.you, role: 'admin' } };
    try {
      render(<WorkspaceSwitcher />);
      await userEvent.click(screen.getByRole('button', { name: /Switch brand/ }));
      expect(screen.queryByRole('menuitem', { name: 'New brand…' })).toBeNull();
    } finally {
      session.memberships = original;
      session.workspace = originalWorkspace;
    }
  });
});

describe('desktop navigation collapse (#180)', () => {
  it('collapses to the icon rail and remembers the choice after a reload', async () => {
    const first = render(
      <Shell>
        <p>Page</p>
      </Shell>,
    );
    const sidebar = () => document.getElementById('app-sidebar')!;
    expect(sidebar().className).toContain('w-[232px]');
    const toggle = screen.getByRole('button', { name: 'Collapse navigation' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('app-sidebar');

    await userEvent.click(toggle);
    expect(sidebar().className).toContain('w-16');
    expect(localStorage.getItem('am.nav.u1')).toBe('collapsed');
    expect(screen.getByRole('button', { name: 'Expand navigation' }).getAttribute('aria-expanded')).toBe('false');
    // The rail keeps the pending-approvals badge and accessible group names.
    expect(screen.getByRole('link', { name: /Approvals, 3 pending/ }).textContent).toContain('3');
    expect(screen.getByRole('button', { name: 'Build navigation' })).toBeTruthy();

    first.unmount();
    render(
      <Shell>
        <p>Page</p>
      </Shell>,
    );
    expect(sidebar().className).toContain('w-16');
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeTruthy();
  });
});
