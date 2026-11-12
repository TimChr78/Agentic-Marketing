import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteErrorBoundary } from '../src/app/ErrorBoundary';
import { match } from '../src/app/router';
import ArtifactPage from '../src/pages/artifacts/ArtifactPage';
import { ToastProvider } from '../src/ui';

// #791: a malformed percent escape in a path segment made `match()` throw URIError during render,
// unmounting the whole SPA. The guard keeps the raw segment (so the page's own recoverable error
// shows), and a root boundary catches anything else instead of leaving a blank page.

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'artifacts.get') throw new Error('This item does not exist.');
        if (name === 'approvals.list') return { approvals: [], total: 0, nextCursor: null };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({
    can: () => true,
    status: 'signed-in',
    workspace: { id: 'ws_1', approvalPolicy: 'none' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  });
  return { useSession: session, useWorkspace: session };
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function Boom(): never {
  throw new Error('render exploded');
}

describe('malformed route parameters (#791)', () => {
  it('keeps a malformed percent escape as the raw parameter instead of throwing', () => {
    expect(match('/artifacts/:id', '/artifacts/%')).toEqual({ id: '%' });
    expect(match('/artifacts/:id', '/artifacts/%ZZ')).toEqual({ id: '%ZZ' });
    expect(match('/artifacts/:id', '/artifacts/%E0%A4%A')).toEqual({ id: '%E0%A4%A' });
  });

  it('renders a recoverable error for the matched /artifacts/% route instead of a blank page', async () => {
    window.history.replaceState(null, '', '/artifacts/%');
    const params = match('/artifacts/:id', new URL(location.href).pathname);
    expect(params).toEqual({ id: '%' });

    render(
      <ToastProvider>
        <RouteErrorBoundary>
          <ArtifactPage params={params ?? {}} />
        </RouteErrorBoundary>
      </ToastProvider>,
    );

    expect(await screen.findByText("Couldn't open this item")).toBeTruthy();
    expect(screen.getByText(/This item does not exist/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('shows the boundary page when a route throws during render', () => {
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );

    expect(screen.getByText('This page could not be shown')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/');
  });
});
