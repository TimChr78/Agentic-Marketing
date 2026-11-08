import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeAttention } from '../../home/HomeAttention';
import { HomeKpis } from '../../home/HomeKpis';
import { HomeRunning } from '../../home/HomeRunning';
import { homeClock } from '../../home/period';
import type { HomeData } from '../../home/useHomeData';

// Phase 28 (#556) W acceptance: every loaded-empty Home block names its next action, and the
// loading slots use the shared object-specific skeleton labels. Rendering the blocks directly
// keeps this a presentation check: no transport, no fixture server.

// Unmount after each test: the skeleton's reveal timer must not fire after the environment is gone.
afterEach(cleanup);

const AS_OF = '2026-11-08T10:00:00.000Z';
const CLOCK = homeClock(new Date(AS_OF), 'UTC');

const loaded = <T,>(data: T) => ({ data, error: null, loading: false, loadedAt: AS_OF });
const loading = { data: undefined, error: null, loading: true, loadedAt: null };

const emptyResources = {
  broadcasts: loaded({ broadcasts: [], total: 0, asOf: AS_OF }),
  journeys: loaded({ artifacts: [], nextCursor: null }),
  agents: loaded({ agents: [] }),
  approvals: loaded({ approvals: [], total: 0, nextCursor: null }),
  alerts: loaded({ rules: [] }),
  failures: loaded({ runs: [], asOf: AS_OF, nextCursor: null }),
  performance: loading,
  brand: loading,
  profiles: loading,
  status: loading,
};

const loadingResources = {
  broadcasts: loading,
  journeys: loading,
  agents: loading,
  approvals: loading,
  alerts: loading,
  failures: loading,
  performance: loading,
  brand: loading,
  profiles: loading,
  status: loading,
};

function home(resources: Record<string, unknown>): Pick<HomeData, 'resources' | 'clock' | 'retry'> {
  const retry = Object.fromEntries(
    ['approvals', 'agents', 'alerts', 'failures', 'broadcasts', 'journeys', 'brand', 'profiles', 'status', 'performance'].map((key) => [
      key,
      async () => {},
    ]),
  );
  return { resources, clock: CLOCK, retry } as unknown as Pick<HomeData, 'resources' | 'clock' | 'retry'>;
}

describe('Home empty blocks', () => {
  it('names the next action for every Running block, without claiming an exhaustive count', () => {
    render(<HomeRunning data={home(emptyResources)} />);

    const broadcasts = screen.getByText('No scheduled or sending broadcasts').closest('p');
    expect(broadcasts?.textContent).toContain('No scheduled or sending broadcasts in this sample.');
    expect(screen.getByRole('link', { name: 'View broadcasts to check their status' })).toBeTruthy();
    const journeys = screen.getByText('No live journeys').closest('p');
    expect(journeys?.textContent).toContain('No live journeys in this sample.');
    expect(screen.getByRole('link', { name: 'View journeys to check their status' })).toBeTruthy();
    const agents = screen.getByText('No active agents').closest('p');
    expect(agents?.textContent).toContain('No active agents in this sample.');
    expect(screen.getByRole('link', { name: 'View agents to check their status' })).toBeTruthy();
  });

  it('names the next action for every Needs attention block', () => {
    render(<HomeAttention data={home(emptyResources)} can={() => true} />);

    const pending = screen.getAllByText('No pending requests');
    expect(pending).toHaveLength(2);
    expect(pending[0].closest('p')?.textContent).toContain('No pending requests in this sample.');
    expect(screen.getAllByRole('link', { name: 'View Approvals' }).length).toBeGreaterThan(0);
    expect(screen.getByText('No firing alerts')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View alerts to check the rules' })).toBeTruthy();
    expect(screen.getByText('No guardian caps')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View agents to review their limits' })).toBeTruthy();
    expect(screen.getByText('No failed hosted runs in the last 7 days')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View agents to check their runs' })).toBeTruthy();
  });
});

describe('Home loading slots', () => {
  it('labels each Running block with its object', () => {
    render(<HomeRunning data={home(loadingResources)} />);

    expect(screen.getByRole('status', { name: 'Loading scheduled and sending broadcasts' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading live journeys' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading active agents' })).toBeTruthy();
  });

  it('reserves the four KPI tiles under their object labels', () => {
    render(<HomeKpis resource={loading} period={CLOCK.period} onRetry={() => {}} />);

    for (const name of ['E-mails sent', 'Delivered', 'Clicked', 'Click rate']) {
      const region = screen.getByRole('status', { name });
      expect(region.getAttribute('data-geometry')).toBe('kpi');
      expect(region.getAttribute('aria-busy')).toBe('true');
    }
  });
});
