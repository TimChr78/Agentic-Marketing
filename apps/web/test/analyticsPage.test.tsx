import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnalyticsPage from '../src/pages/insights/AnalyticsPage';
import { setWorkspaceTimeZone } from '../src/ui/time';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: any }[],
}));

const catalog = {
  measures: [
    {
      id: 'email.sent',
      description: 'Sent',
      unit: 'count',
      aggregation: 'count',
      source: 'message_events',
      dimensions: ['day', 'broadcast'],
      defaultGrain: 'day',
      kind: 'base',
    },
    {
      id: 'email.delivered',
      description: 'Delivered',
      unit: 'count',
      aggregation: 'count',
      source: 'message_events',
      dimensions: ['day', 'broadcast'],
      defaultGrain: 'day',
      kind: 'base',
    },
    {
      id: 'email.click_rate',
      description: 'Click rate',
      unit: 'ratio',
      aggregation: 'ratio',
      source: 'message_events',
      dimensions: ['day', 'broadcast'],
      defaultGrain: 'day',
      kind: 'ratio',
    },
  ],
  dimensions: [
    { id: 'day', description: 'Day', time: true, sources: ['message_events'] },
    { id: 'broadcast', description: 'Broadcast', time: false, sources: ['message_events'] },
  ],
};

const emptyResult = {
  columns: [],
  rows: [],
  meta: {
    timeZone: 'UTC',
    currency: null,
    from: '2026-10-30T00:00:00.000Z',
    to: '2026-11-05T23:59:59.999Z',
    freshness: null,
    suppressed: 0,
    k: 5,
    notes: [],
  },
};

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: unknown) => {
        h.calls.push({ name, input });
        if (name === 'analytics.metrics.list') return catalog;
        if (name === 'analytics.query') return emptyResult;
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, workspace: { id: 'ws_1' }, user: { id: 'u1' } }),
  useWorkspace: () => ({ can: () => true, workspace: { id: 'ws_1' }, user: { id: 'u1' } }),
}));

const broadcast = `bct_${'a'.repeat(32)}`;

beforeEach(() => {
  // Date-only links resolve in the workspace zone; UTC keeps the expected instants readable.
  setWorkspaceTimeZone('UTC');
  cleanup();
  h.calls.length = 0;
});

const renderAt = (query: string) => {
  history.replaceState(null, '', `/insights/analytics?${query}`);
  return render(<AnalyticsPage />);
};

describe('Analytics from a link (#449 review)', () => {
  it('initialises the range and measures from the link and keeps the broadcast filter in the request', async () => {
    renderAt(`from=2026-10-30&to=2026-11-05&measures=email.sent,email.delivered&dimensions=day&broadcast=${broadcast}`);

    await waitFor(() => expect(h.calls.some((call) => call.name === 'analytics.query')).toBe(true));
    const query = h.calls.filter((call) => call.name === 'analytics.query').at(-1)!;
    expect(query.input).toMatchObject({
      measures: ['email.sent', 'email.delivered'],
      dimensions: ['day'],
      from: '2026-10-30T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
      filters: { broadcast: [broadcast] },
    });
    expect(screen.getByLabelText('From')).toHaveProperty('value', '2026-10-30');
    expect(screen.getByLabelText('To')).toHaveProperty('value', '2026-11-05');
  });

  it('shows the broadcast as a removable filter chip', async () => {
    renderAt(`broadcast=${broadcast}`);
    await waitFor(() => expect(h.calls.some((call) => call.name === 'analytics.query')).toBe(true));
    expect(screen.getByText('Broadcast filter')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove broadcast filter' }));
    await waitFor(() => expect(screen.queryByText('Broadcast filter')).toBeNull());
    expect(location.search).not.toContain('broadcast');
    await waitFor(() => {
      const query = h.calls.filter((call) => call.name === 'analytics.query').at(-1)!;
      expect(query.input.filters).toBeUndefined();
    });
  });
});
