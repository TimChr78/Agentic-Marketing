import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCommandTransport } from '../../../app/api';
import { createDemoTransport, DEMO_MUTATIONS, DEMO_READ_ONLY_MESSAGE, demoReads } from '../integration/demo';
import { DEMO_READ_NAMES } from './reads';

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
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('demo read projection (#530)', () => {
  it('lists every destination read and never falls back to the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const reads = demoReads();
    for (const name of DEMO_READ_NAMES) expect(reads[name], `${name} is not served`).toBeTypeOf('function');

    const transport = createDemoTransport();
    const calls: [string, unknown][] = [
      ['workspace.get', {}],
      ['agents.list', {}],
      ['alerts.list', {}],
      ['broadcasts.list', {}],
      ['system.status', {}],
      ['profiles.list', { limit: 50 }],
      ['analytics.metrics.list', {}],
      [
        'analytics.query',
        { measures: ['email.sent', 'email.click_rate'], dimensions: [], from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z' },
      ],
      ['artifacts.get', { artifactId: 'eml_00000000000000000000000000000000' }],
    ];
    for (const [name, input] of calls) {
      await transport(name as never, input as never).catch(() => undefined);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves the artifact and approval detail reads the demo links open', async () => {
    const transport = createDemoTransport();
    const list = await transport('artifacts.list', { type: 'email_template', limit: 200 });
    const id = list.artifacts[0]!.id;
    const detail = await transport('artifacts.get', { artifactId: id });
    expect(detail.id).toBe(id);
    expect(detail.version.content).toBeDefined();
    const versions = await transport('artifacts.history', { artifactId: id });
    expect(versions.versions.length).toBeGreaterThan(0);
    const diff = await transport('artifacts.diff', { artifactId: id });
    expect(diff.to).toBe(detail.latestVersion);

    const approvals = await transport('approvals.list', { status: 'pending', limit: 200 });
    const approval = await transport('approvals.get', { approvalId: approvals.approvals[0]!.id });
    expect(approval.id).toBe(approvals.approvals[0]!.id);
    expect(approval.content).toBeDefined();
  });

  it('reconciles Home totals with the Analytics series for the same period', async () => {
    const transport = createDemoTransport();
    const from = '2026-11-01T00:00:00.000Z';
    const to = '2026-11-08T00:00:00.000Z';
    const totals = await transport('analytics.query', { measures: ['email.sent', 'email.clicked'], dimensions: [], from, to, limit: 1 });
    const series = await transport('analytics.query', {
      measures: ['email.sent', 'email.clicked'],
      dimensions: ['day'],
      from,
      to,
      limit: 5000,
      order: { by: 'day', dir: 'asc' },
    });
    const sentIndex = totals.columns.findIndex((c) => c.name === 'email.sent');
    const seriesSentIndex = series.columns.findIndex((c) => c.name === 'email.sent');
    const summed = (series.rows as (string | number | null)[][]).reduce((sum, row) => sum + Number(row[seriesSentIndex] ?? 0), 0);
    expect(totals.rows[0]![sentIndex]).toBe(summed);
  });

  it('refuses every mutation with the demo message and blocks the real API', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const uninstall = setCommandTransport(createDemoTransport());
    for (const name of DEMO_MUTATIONS) {
      await expect(api.call(name as never, {} as never)).rejects.toMatchObject({ code: 'demo_read_only', message: DEMO_READ_ONLY_MESSAGE });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    uninstall();
  });

  it('names an unlisted read as unavailable instead of inventing a result', async () => {
    const transport = createDemoTransport();
    await expect(transport('nothing.like.this' as never, {} as never)).rejects.toMatchObject({ status: 404, code: 'demo_unavailable' });
  });
});

const DESTINATIONS: { path: string; heading: string }[] = [
  { path: '/', heading: 'Home' },
  { path: '/approvals', heading: 'Approvals' },
  { path: '/audience/people', heading: 'People' },
  { path: '/marketing/journeys', heading: 'Journeys' },
  { path: '/content/templates', heading: 'E-mail templates' },
  { path: '/insights/analytics', heading: 'Analytics' },
  { path: '/settings/integrations', heading: 'Integrations and API tokens' },
];

describe('demo destinations render on the real shell (#530)', () => {
  for (const destination of DESTINATIONS) {
    it(`${destination.path} renders ${destination.heading} with the marker and no network`, async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      window.history.replaceState(null, '', destination.path);
      const { DemoRoot } = await import('../integration/demo/DemoRoot');
      render(<DemoRoot />);

      expect(await screen.findByRole('note', { name: 'Demo mode' })).toBeTruthy();
      expect(await screen.findByRole('heading', { level: 1, name: destination.heading })).toBeTruthy();
      expect(screen.getByText('Simulated demo · sample data')).toBeTruthy();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('keeps all six navigation groups in the real shell', async () => {
    vi.stubGlobal('fetch', vi.fn());
    window.history.replaceState(null, '', '/');
    const { DemoRoot } = await import('../integration/demo/DemoRoot');
    render(<DemoRoot />);

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const group of ['Work', 'Marketing', 'Audience', 'Content', 'Insights']) {
      expect(within(nav).getAllByText(group).length, group).toBeGreaterThan(0);
    }
    // Settings is pinned outside the work groups in the ordinary shell.
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0);
  });

  it('renders an unknown demo address as Not found inside the demo', async () => {
    vi.stubGlobal('fetch', vi.fn());
    window.history.replaceState(null, '', '/demo/not-a-real-destination');
    const { DemoRoot } = await import('../integration/demo/DemoRoot');
    render(<DemoRoot />);

    expect(await screen.findByText("This page doesn't exist")).toBeTruthy();
    expect(screen.getByRole('note', { name: 'Demo mode' })).toBeTruthy();
  });

  it('opens the legacy hash links at their real destinations', async () => {
    const { enterDemo } = await import('./entry');
    const rows: [string, string][] = [
      ['#overview', '/'],
      ['#profiles', '/audience/people'],
      ['#email', '/content/templates'],
      ['#setup', '/settings/integrations'],
      ['#journeys', '/marketing/journeys'],
      ['#analytics', '/insights/analytics'],
      ['#approvals', '/approvals'],
    ];
    for (const [hash, path] of rows) {
      window.history.replaceState(null, '', `/demo${hash}`);
      enterDemo();
      expect(window.location.pathname, hash).toBe(path);
      expect(window.history.state.demo).toBe(true);
    }
  });

  it('keeps an unknown demo address in the demo as Not found', async () => {
    const { enterDemo } = await import('./entry');
    window.history.replaceState(null, '', '/demo/not-a-real-destination');
    enterDemo();
    expect(window.location.pathname).toBe('/not-a-real-destination');
    expect(window.history.state.demo).toBe(true);
  });

  it('maps the retired live-site walkthrough to Home with a short non-executing notice', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', '/demo#live');
    const { DemoRoot } = await import('../integration/demo/DemoRoot');
    render(<DemoRoot />);

    expect(await screen.findByText(/live-site walkthrough has been retired/i)).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
