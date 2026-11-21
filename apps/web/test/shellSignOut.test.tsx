import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1173: sign-out is a security boundary (#614), so a failed sign-out keeps the person signed in
// and on the page they were using. Only a confirmed sign-out leaves for `/`.

const { session, navigate } = vi.hoisted(() => ({
  navigate: vi.fn(),
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
      brand: { siteName: 'Martech Signal', logoUrl: null, primaryDomain: null },
      serverVersion: '0.17.5',
      you: { type: 'user', userId: 'u1', role: 'owner', permissions: ['artifacts:read', 'workspace:admin'] },
      permissionsExplained: [],
    },
    memberships: [],
    can: () => true,
    refresh: async () => {},
    switchWorkspace: vi.fn(async () => {}),
    signOut: vi.fn(async (): Promise<boolean> => false),
    signOutError: null,
    pending: 0,
    refreshPending: () => {},
  },
}));

vi.mock('../src/app/router', () => ({
  navigate,
  useLocation: () => ({ path: '/audience/people', search: new URLSearchParams(), href: '/audience/people' }),
  Link: ({ to, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
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

const { Shell } = await import('../src/app/Shell');

beforeEach(() => {
  localStorage.clear();
  navigate.mockClear();
  session.signOut.mockReset();
});

afterEach(() => cleanup());

async function signOutFromAccountMenu() {
  await userEvent.click(screen.getByRole('button', { name: /Account menu for/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
}

describe('sign-out navigation (#1173)', () => {
  it('stays on the current page when the server did not confirm the sign-out', async () => {
    session.signOut.mockResolvedValue(false);
    render(
      <Shell>
        <p>Page</p>
      </Shell>,
    );

    await signOutFromAccountMenu();

    await waitFor(() => expect(session.signOut).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText('Page')).toBeTruthy();
  });

  it('goes home after a confirmed sign-out', async () => {
    session.signOut.mockResolvedValue(true);
    render(
      <Shell>
        <p>Page</p>
      </Shell>,
    );

    await signOutFromAccountMenu();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }));
  });
});
