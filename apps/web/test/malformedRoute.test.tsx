import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteErrorBoundary } from '../src/app/ErrorBoundary';
import { match, setSearchParam } from '../src/app/router';
import { Routes } from '../src/app/routes';
import ArtifactPage from '../src/pages/artifacts/ArtifactPage';
import { ToastProvider } from '../src/ui';

// The route table loads its pages lazily; this stands in for one so a route can be mounted without
// its data reads, and counts how often the route actually mounts (an effect, not a render).
const mountCount = vi.hoisted(() => ({ value: 0 }));
vi.mock('../src/pages/audience/PeoplePage', async () => {
  const { useEffect } = await import('react');
  return {
    default: () => {
      useEffect(() => {
        mountCount.value++;
      }, []);
      return <p>People page</p>;
    },
  };
});

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

  it('retries the same route from the boundary', () => {
    let broken = true;
    function Sometimes() {
      if (broken) throw new Error('render exploded');
      return <p>Recovered page</p>;
    }

    render(
      <RouteErrorBoundary resetKey="/artifacts/one">
        <Sometimes />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText('This page could not be shown')).toBeTruthy();

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered page')).toBeTruthy();
  });

  it('clears a failed route on navigation, not on a same-route re-render', () => {
    let broken = true;
    function Sometimes() {
      if (broken) throw new Error('render exploded');
      return <p>Recovered page</p>;
    }

    const { rerender } = render(
      <RouteErrorBoundary resetKey="/artifacts/one">
        <Sometimes />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText('This page could not be shown')).toBeTruthy();

    // The error clears only when the path changes; a plain re-render keeps the boundary page.
    broken = false;
    rerender(
      <RouteErrorBoundary resetKey="/artifacts/one">
        <Sometimes />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText('This page could not be shown')).toBeTruthy();

    rerender(
      <RouteErrorBoundary resetKey="/artifacts/two">
        <Sometimes />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText('Recovered page')).toBeTruthy();
  });

  it('does not remount the route when only the query string changes', async () => {
    mountCount.value = 0;
    window.history.replaceState(null, '', '/audience/people');
    render(
      <ToastProvider>
        <Routes />
      </ToastProvider>,
    );
    expect(await screen.findByText('People page')).toBeTruthy();
    expect(mountCount.value).toBe(1);

    // A tab or filter change lives in the query string; the mounted page keeps its state.
    act(() => setSearchParam('tab', 'blocked'));
    expect(screen.getByText('People page')).toBeTruthy();
    expect(mountCount.value).toBe(1);
  });
});
