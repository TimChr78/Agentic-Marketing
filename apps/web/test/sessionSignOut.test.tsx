import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #614: sign-out is a security boundary. Local session state may only be cleared after the server
// confirms it (2xx), or when the server says the session is already gone (401). A refusal or a
// network error keeps the person signed in and says the sign-out did not go through.

const h = vi.hoisted(() => ({
  signOut: {} as { ok: boolean; status: number },
  thrown: null as Error | null,
}));

vi.mock('../src/app/theme', () => ({
  setThemeUser: vi.fn(),
  setThemePref: vi.fn(),
  getThemePref: () => 'system',
  useThemePref: () => 'system',
  useResolvedTheme: () => 'light',
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'workspace.get') throw new actual.ApiError(401, 'unauthorized', 'No workspace');
        if (name === 'workspace.memberships') return { workspaces: [] };
        if (name === 'approvals.list') return { approvals: [], total: 0, nextCursor: null };
        throw new Error(`unexpected command ${name}`);
      }),
    },
    getWorkspaceId: () => null,
    setWorkspaceId: vi.fn(),
  };
});

import { Root } from '../src/app/Root';

const response = (status: number) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({}),
  text: async () => '',
});

const signedIn = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/get-session')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: { id: 'usr_1', name: 'Ada', email: 'ada@example.com' } }),
        };
      }
      if (url.includes('/api/auth/sign-out')) {
        if (h.thrown) throw h.thrown;
        return response(h.signOut.status);
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );

beforeEach(() => {
  h.signOut = { ok: true, status: 200 };
  h.thrown = null;
  signedIn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sign-out waits for the server (#614)', () => {
  it('keeps the session and shows an error when the server refuses (500)', async () => {
    h.signOut = { ok: false, status: 500 };
    render(<Root />);
    expect(await screen.findByText(/not in a workspace yet/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText(/sign-out did not go through/i)).toBeTruthy();
    expect(screen.getByText(/not in a workspace yet/i)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  it('keeps the session and shows an error when the fetch rejects', async () => {
    h.thrown = new TypeError('Network unavailable');
    render(<Root />);
    expect(await screen.findByText(/not in a workspace yet/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText(/sign-out did not go through/i)).toBeTruthy();
    expect(screen.getByText(/not in a workspace yet/i)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  it('clears the session after a 2xx', async () => {
    h.signOut = { ok: true, status: 200 };
    render(<Root />);
    expect(await screen.findByText(/not in a workspace yet/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText(/not in a workspace yet/i)).toBeNull();
  });

  it('treats a 401 as already signed out', async () => {
    h.signOut = { ok: false, status: 401 };
    render(<Root />);
    expect(await screen.findByText(/not in a workspace yet/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText(/sign-out did not go through/i)).toBeNull();
  });
});
