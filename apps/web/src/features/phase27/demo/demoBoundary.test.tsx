import { cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRouterBasePath, routerHref, setRouterBasePath } from '../../../app/router';
import { enterDemo, installDemoHistory, isDemoEntry } from './entry';
import { teardownDemoRuntime } from './runtime';

const media = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', media);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('scrollTo', () => {});
});

afterEach(async () => {
  cleanup();
  setRouterBasePath('');
  teardownDemoRuntime();
  await Promise.resolve();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('demo URL boundary (#530)', () => {
  it('normalizes dot segments and duplicate slashes inside the base', () => {
    setRouterBasePath('/demo');
    expect(routerHref('/../approvals')).toBe('/demo/approvals');
    expect(routerHref('/./approvals')).toBe('/demo/approvals');
    expect(routerHref('//approvals')).toBe('/demo/approvals');
    expect(routerHref('/demo/../approvals')).toBe('/demo/approvals');
    expect(routerHref('/demo//audience///people')).toBe('/demo/audience/people');
    expect(routerHref('/demo')).toBe('/demo');
    expect(routerHref('/')).toBe('/demo');
    setRouterBasePath('');
    expect(routerHref('/../approvals')).toBe('/approvals');
  });

  it('confines a pushed production path to /demo instead of stamping it', () => {
    setRouterBasePath('/demo');
    window.history.replaceState({ demo: true }, '', '/demo');
    const uninstall = installDemoHistory();
    window.history.pushState(null, '', '/approvals');
    expect(window.location.pathname).toBe('/demo/approvals');
    expect(window.history.state.demo).toBe(true);
    window.history.pushState(null, '', '/demo/../settings/workspace');
    expect(window.location.pathname).toBe('/demo/settings/workspace');
    uninstall();
  });

  it('requires the /demo namespace, not history state alone', () => {
    window.history.replaceState({ demo: true }, '', '/approvals');
    expect(isDemoEntry()).toBe(false);
    window.history.replaceState(null, '', '/demo/approvals');
    expect(isDemoEntry()).toBe(true);
  });

  it('keeps the router base through a StrictMode double mount', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', '/demo/approvals');
    const { DemoRoot } = await import('../integration/demo/DemoRoot');
    render(
      <StrictMode>
        <DemoRoot />
      </StrictMode>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
    expect(getRouterBasePath()).toBe('/demo');
    expect(window.location.pathname).toBe('/demo/approvals');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a legacy hash inside the namespace', () => {
    setRouterBasePath('');
    window.history.replaceState(null, '', '/demo#profiles');
    enterDemo();
    expect(window.location.pathname).toBe('/demo/audience/people');
  });
});
