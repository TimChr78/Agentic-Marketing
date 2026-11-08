import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForWorkspace, setCommandTransport, setStreamTransport, streamFetch } from '../../../app/api';
import { DEMO_READ_ONLY_MESSAGE, installDemoStreamTransport, installDemoTransport } from '../integration/demo';

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

afterEach(() => {
  cleanup();
  setCommandTransport(null);
  setStreamTransport(null);
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  document.cookie = 'am.session=; Max-Age=0; path=/';
});

describe('demo isolation from the real session (#530)', () => {
  it('guards the streaming copilot transport', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const uninstall = installDemoStreamTransport();
    await expect(streamFetch('/api/copilot', { method: 'POST' })).rejects.toMatchObject({
      status: 403,
      code: 'demo_read_only',
      message: DEMO_READ_ONLY_MESSAGE,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    uninstall();
    expect(streamFetch).toBeTypeOf('function');
  });

  it('a demo copilot submit makes no request even with a real session cookie present', async () => {
    document.cookie = 'am.session=real-session; path=/';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', '/demo');
    const { DemoRoot } = await import('../integration/demo/DemoRoot');
    render(<DemoRoot />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copilot' }));
    expect(await screen.findByText('The assistant is not available in the demo')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes every workspace-specific client through the installed transport', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const calls: string[] = [];
    setCommandTransport((async (name: string) => {
      calls.push(name);
      return { name: 'MartechSignal' };
    }) as never);
    await apiForWorkspace('another-workspace').call('workspace.get', {} as never);
    expect(calls).toEqual(['workspace.get']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes a cross-brand client through the demo transport', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    installDemoTransport();
    const otherBrand = apiForWorkspace('00000000-0000-4000-8000-000000000999');
    await expect(
      otherBrand.call('apiTokens.create', {
        name: 'Hermes',
        scopes: ['artifacts:read'],
      } as never),
    ).rejects.toMatchObject({ status: 403, code: 'demo_read_only', message: DEMO_READ_ONLY_MESSAGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
