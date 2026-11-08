import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('real-shell demo mode (#524)', () => {
  it('renders the real shell under a persistent sample-data marker without one network call', async () => {
    vi.stubGlobal('matchMedia', media);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', '/');
    const { DemoRoot } = await import('../src/features/phase27/integration/demo/DemoRoot');

    render(<DemoRoot />);

    expect(await screen.findByRole('note', { name: 'Demo mode' })).toBeTruthy();
    expect(screen.getByText('Simulated demo · sample data')).toBeTruthy();
    // The ordinary shell navigation is the real one, not a demo-specific sidebar.
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
