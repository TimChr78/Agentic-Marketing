import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeliverabilityPage from '../../pages/insights/DeliverabilityPage';
import { setWorkspaceTimeZone } from '../../ui/time';
import { reportPeriod } from '../broadcasts/period';
import type { Domains } from './DnsCards';
import { type Health, pointRate, type Rates, streamVerdict, type Thresholds, type Trend } from './model';

type Call = { name: string; input: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  canArtifacts: true,
  canAdmin: true,
  health: null as unknown,
  healthError: null as Error | null,
  trend: null as unknown,
  trendError: null as Error | null,
  trendHandler: null as null | ((input: Record<string, unknown>) => unknown),
  domains: null as unknown,
  domainsError: null as Error | null,
  hold: false,
}));

vi.mock('../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (h.hold) return new Promise(() => {});
        if (name === 'deliverability.health') {
          if (h.healthError) throw h.healthError;
          return h.health;
        }
        if (name === 'deliverability.trend') {
          if (h.trendError) throw h.trendError;
          if (h.trendHandler) return await h.trendHandler(input);
          return h.trend;
        }
        if (name === 'sendingDomains.list') {
          if (h.domainsError) throw h.domainsError;
          return h.domains;
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../app/session', () => ({
  useSession: () => ({
    can: (permission: string) => (permission === 'artifacts:read' ? h.canArtifacts : permission === 'workspace:admin' ? h.canAdmin : true),
    workspace: { id: 'ws_1' },
    user: { id: 'u1' },
  }),
  useWorkspace: () => ({
    can: (permission: string) => (permission === 'artifacts:read' ? h.canArtifacts : permission === 'workspace:admin' ? h.canAdmin : true),
    workspace: { id: 'ws_1' },
    user: { id: 'u1' },
  }),
}));

const THRESHOLDS: Thresholds = { complaintWarn: 0.001, complaintStop: 0.003, bounceStop: 0.05, minVolume: 200 };

const healthyRates: Rates = {
  sent: 2_000,
  bounced: 30,
  complained: 1,
  bounceRate: 0.015,
  complaintRate: 0.0005,
  status: 'ok',
  reason: null,
};

const zeroRates: Rates = {
  sent: 0,
  bounced: 0,
  complained: 0,
  bounceRate: 0,
  complaintRate: 0,
  status: 'ok',
  reason: null,
};

function healthFixture(
  overrides: {
    windowDays?: number;
    autoPause?: boolean;
    thresholds?: Partial<Thresholds>;
    emailMarketing?: Partial<Rates>;
    emailTransactional?: Partial<Rates>;
    smsMarketing?: Partial<Rates>;
    smsTransactional?: Partial<Rates>;
  } = {},
): Health {
  return {
    windowDays: overrides.windowDays ?? 7,
    thresholds: { ...THRESHOLDS, ...overrides.thresholds },
    autoPause: overrides.autoPause ?? true,
    email: {
      marketing: { ...healthyRates, ...overrides.emailMarketing },
      transactional: { ...zeroRates, ...overrides.emailTransactional },
    },
    sms: {
      marketing: { ...zeroRates, ...overrides.smsMarketing },
      transactional: { ...zeroRates, ...overrides.smsTransactional },
    },
    brand: { linksUrl: 'https://links.example.com', linksHost: 'links.example.com' },
  };
}

function point(
  day: string,
  sent: number,
  bounced: number,
  complained: number,
  bounceRate: number | null,
  complaintRate: number | null,
): Trend['points'][number] {
  return {
    day,
    windowFrom: `${day}T00:00:00.000Z`,
    windowTo: `${day}T23:59:59.000Z`,
    sent,
    bounced,
    complained,
    bounceRate,
    complaintRate,
  };
}

const defaultPoints: Trend['points'] = [
  point('2026-10-31', 1_800, 27, 1, 0.015, 0.00056),
  point('2026-11-01', 1_900, 28, 1, 0.0147, 0.00053),
  point('2026-11-02', 2_000, 30, 1, 0.015, 0.0005),
  point('2026-11-03', 2_000, 30, 1, 0.015, 0.0005),
  point('2026-11-04', 2_000, 30, 1, 0.015, 0.0005),
  point('2026-11-05', 2_000, 30, 1, 0.015, 0.0005),
  point('2026-11-06', 2_000, 30, 1, 0.015, 0.0005),
];

function trendFixture(points: Trend['points'] = defaultPoints, overrides: Partial<Trend> = {}): Trend {
  return {
    points,
    windowDays: 7,
    thresholds: { ...THRESHOLDS },
    autoPause: true,
    timeZone: 'UTC',
    computedAt: '2026-11-07T08:30:00.000Z',
    semantics: 'current_status_by_creation_window',
    ...overrides,
  };
}

function domainsFixture(overrides: Partial<Domains> = {}): Domains {
  return {
    checkedAt: '2026-11-07T08:58:00.000Z',
    domains: [
      {
        domain: 'news.example.com',
        ok: false,
        uses: ['marketing'],
        spf: { ok: true, record: 'v=spf1 include:amazonses.com ~all', advice: null },
        dkim: [],
        dmarc: { ok: false, record: null, policy: null, advice: 'Add a DMARC policy with your DNS administrator.' },
      },
      {
        domain: 'tx.example.com',
        ok: false,
        uses: ['transactional'],
        spf: { ok: false, record: null, advice: 'Add a TXT record at tx.example.com.' },
        dkim: [{ selector: 's1', ok: false, record: null }],
        dmarc: { ok: true, record: 'v=DMARC1; p=none', policy: 'none', advice: 'DMARC is monitoring only (p=none).' },
      },
    ],
    ...overrides,
  };
}

const trendCalls = () => h.calls.filter((call) => call.name === 'deliverability.trend');
const healthCalls = () => h.calls.filter((call) => call.name === 'deliverability.health');
const domainCalls = () => h.calls.filter((call) => call.name === 'sendingDomains.list');

beforeEach(() => {
  setWorkspaceTimeZone('UTC');
  h.calls.length = 0;
  h.canArtifacts = true;
  h.canAdmin = true;
  h.health = healthFixture();
  h.healthError = null;
  h.trend = trendFixture();
  h.trendError = null;
  h.trendHandler = null;
  h.domains = domainsFixture();
  h.domainsError = null;
  h.hold = false;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(cleanup);

describe('Deliverability (#508) reads and access', () => {
  it('makes exactly the three initial reads once, never one per stream or domain', async () => {
    render(<DeliverabilityPage />);
    await waitFor(() => expect(h.calls).toHaveLength(3));

    expect(h.calls.map((call) => call.name).sort()).toEqual(['deliverability.health', 'deliverability.trend', 'sendingDomains.list']);
    const period = reportPeriod(30);
    expect(trendCalls()[0]?.input).toEqual({
      from: period.from,
      to: period.nextMidnight,
      channel: 'email',
      stream: 'marketing',
    });
    expect(domainCalls()[0]?.input).toEqual({ dkimSelectors: [] });
    expect(h.calls.some((call) => call.name.includes('checkDomain'))).toBe(false);
  });

  it('reloads only the trend when the stream changes', async () => {
    render(<DeliverabilityPage />);
    await waitFor(() => expect(h.calls).toHaveLength(3));

    fireEvent.change(screen.getByLabelText('Stream'), { target: { value: 'sms.marketing' } });
    await waitFor(() => expect(trendCalls()).toHaveLength(2));
    expect(trendCalls()[1]?.input).toMatchObject({ channel: 'sms', stream: 'marketing' });
    expect(healthCalls()).toHaveLength(1);
    expect(domainCalls()).toHaveLength(1);
  });

  it('reloads only the trend when the period changes to seven complete days', async () => {
    render(<DeliverabilityPage />);
    await waitFor(() => expect(h.calls).toHaveLength(3));

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '7' } });
    await waitFor(() => expect(trendCalls()).toHaveLength(2));
    const period = reportPeriod(7);
    expect(trendCalls()[1]?.input).toEqual({
      from: period.from,
      to: period.nextMidnight,
      channel: 'email',
      stream: 'marketing',
    });
    expect(healthCalls()).toHaveLength(1);
    expect(domainCalls()).toHaveLength(1);
  });

  it('Refresh rates reruns health and trend, not DNS', async () => {
    render(<DeliverabilityPage />);
    await waitFor(() => expect(h.calls).toHaveLength(3));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh rates' }));
    await waitFor(() => {
      expect(healthCalls()).toHaveLength(2);
      expect(trendCalls()).toHaveLength(2);
    });
    expect(domainCalls()).toHaveLength(1);
  });

  it('Check DNS reruns only the list with trimmed unique selectors capped at five', async () => {
    render(<DeliverabilityPage />);
    await waitFor(() => expect(h.calls).toHaveLength(3));

    fireEvent.change(screen.getByLabelText('DKIM selectors'), {
      target: { value: ' s1, s1, s2 , s3, s4, s5, s6 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    await waitFor(() => expect(domainCalls()).toHaveLength(2));
    expect(domainCalls()[1]?.input).toEqual({ dkimSelectors: ['s1', 's2', 's3', 's4', 's5'] });
    expect(healthCalls()).toHaveLength(1);
    expect(trendCalls()).toHaveLength(1);
  });

  it('issues zero reads and shows no payload when the role lacks artifacts:read', async () => {
    h.canArtifacts = false;
    render(<DeliverabilityPage />);

    expect(screen.getByText('Restricted by your role')).toBeTruthy();
    expect(screen.getByText(/No protected reads were made/)).toBeTruthy();
    await act(async () => {});
    expect(h.calls).toHaveLength(0);
  });

  it('links only authorized admins to configure a sending domain', async () => {
    h.domains = { checkedAt: '2026-11-07T08:58:00.000Z', domains: [] };
    h.canAdmin = true;
    const { unmount } = render(<DeliverabilityPage />);
    await screen.findByText('No sending domains yet');
    expect(screen.getByRole('link', { name: 'Configure sending domain' }).getAttribute('href')).toBe('/settings/providers');
    unmount();
    cleanup();

    h.calls.length = 0;
    h.canAdmin = false;
    render(<DeliverabilityPage />);
    await screen.findByText('No sending domains yet');
    expect(screen.queryByRole('link', { name: 'Configure sending domain' })).toBeNull();
    expect(screen.getByText(/Ask a workspace administrator to configure one/)).toBeTruthy();
  });
});

describe('Deliverability stream states (#508)', () => {
  const base = { ...healthyRates, sent: 200, bounceRate: 0.05, complaintRate: 0.001 };
  const options = { windowDays: 7, marketing: true, autoPause: true };

  it('never claims a pause from zero, and withholds below the evaluation minimum', () => {
    expect(streamVerdict({ ...base, sent: 0, status: 'paused' }, THRESHOLDS, options).label).toBe('No data');
    expect(streamVerdict({ ...base, sent: 199 }, THRESHOLDS, options).label).toBe('Below evaluation volume');
    expect(streamVerdict({ ...base, sent: 200, status: 'ok' }, THRESHOLDS, options).label).toBe('Healthy');
    expect(streamVerdict({ ...base, sent: 200, status: 'warn' }, THRESHOLDS, options).label).toBe('Warning');
  });

  it('calls a stop-threshold pause only for marketing with auto-pause on', () => {
    expect(streamVerdict({ ...base, status: 'paused' }, THRESHOLDS, options).label).toBe('Sending paused');
    expect(streamVerdict({ ...base, status: 'paused' }, THRESHOLDS, { ...options, marketing: false }).label).toBe('Above stop threshold');
    expect(streamVerdict({ ...base, status: 'paused' }, THRESHOLDS, { ...options, autoPause: false }).label).toBe('Above stop threshold');
  });

  it('withholds low-volume and zero-volume trend rates even when the server returned a fraction', () => {
    expect(pointRate(point('2026-11-01', 0, 0, 0, 0, 0), 'bounce', 200)).toEqual({ value: null, withheld: 'no-volume' });
    expect(pointRate(point('2026-11-02', 199, 4, 0, 0.02, 0), 'bounce', 200)).toEqual({
      value: null,
      withheld: 'below-volume',
    });
    expect(pointRate(point('2026-11-03', 200, 4, 0, 0.02, 0), 'bounce', 200)).toEqual({ value: 2, withheld: 'none' });
    expect(pointRate(point('2026-11-04', 2_000, 0, 0, null, null), 'bounce', 200)).toEqual({
      value: null,
      withheld: 'unavailable',
    });
  });

  it('shows a null rate on a sufficient sample as Unavailable, never 0%', async () => {
    h.health = healthFixture({ emailMarketing: { bounceRate: null as unknown as number } });
    h.trend = trendFixture([point('2026-11-06', 2_000, 0, 0, null, null)]);
    render(<DeliverabilityPage />);

    await screen.findAllByText('Unavailable');
    expect(screen.queryByText('0.00%')).toBeNull();
  });

  it('shows withheld health rates, the raw sample and the minimum', async () => {
    h.health = healthFixture({
      emailMarketing: { sent: 42, bounced: 1, complained: 0, bounceRate: 0.0238, complaintRate: 0, status: 'ok' },
    });
    h.trend = trendFixture([
      point('2026-11-04', 0, 0, 0, null, null),
      point('2026-11-05', 50, 1, 0, 0.02, 0),
      point('2026-11-06', 200, 4, 0, 0.02, 0),
    ]);
    render(<DeliverabilityPage />);

    await screen.findByText('Not evaluated · 42 / 200 required');
    expect(screen.getAllByText('Below evaluation volume').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No denominator available').length).toBeGreaterThan(0);
    expect(screen.getByText('42 / minimum 200')).toBeTruthy();
    expect(screen.getAllByText('No volume').length).toBeGreaterThan(0);
    expect(screen.queryByText('2.38%')).toBeNull();
    expect(screen.getAllByText('Not evaluated; no healthy claim.').length).toBeGreaterThan(0);
  });

  it('draws all three current threshold lines with numeric labels and dashes', async () => {
    render(<DeliverabilityPage />);

    await screen.findByText('Current stop threshold 5%');
    expect(screen.getByText('Stop ≥0.3%')).toBeTruthy();
    expect(screen.getByText('Warn ≥0.1%')).toBeTruthy();
    expect(document.querySelector('line[data-threshold="bounceStop"]')?.getAttribute('stroke-dasharray')).toBe('8 6');
    expect(document.querySelector('line[data-threshold="complaintStop"]')?.getAttribute('stroke-dasharray')).toBe('8 6');
    expect(document.querySelector('line[data-threshold="complaintWarn"]')?.getAttribute('stroke-dasharray')).toBe('3 5');
    expect(screen.getByText(/Lines show current thresholds, not historic pause decisions/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('%%');
  });
});

describe('Deliverability DNS cards (#508)', () => {
  it('shows the fix beside each failure and never a green pass without selectors', async () => {
    render(<DeliverabilityPage />);

    await screen.findByText('news.example.com');
    expect(screen.getAllByText('DKIM not checked').length).toBeGreaterThan(0);
    expect(screen.getByText('Supply the selectors your provider uses.')).toBeTruthy();
    expect(screen.getByText('policy missing')).toBeTruthy();
    expect(screen.getByText(/Add a DMARC policy with your DNS administrator/)).toBeTruthy();
    expect(screen.getByText('DKIM · s1')).toBeTruthy();
    expect(screen.getByText(/Ask your DNS administrator to verify the provider’s record for this selector/)).toBeTruthy();
    expect(screen.getByText(/Add a TXT record at tx.example.com/)).toBeTruthy();
    expect(screen.queryByText('Records pass')).toBeNull();
  });

  it('copies only the supplied record', async () => {
    render(<DeliverabilityPage />);
    await screen.findByText('news.example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Copy SPF record' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('v=spf1 include:amazonses.com ~all'));
  });
});

describe('Deliverability data states (#508)', () => {
  it('shows section-sized loading states with aria-busy', () => {
    h.hold = true;
    render(<DeliverabilityPage />);

    expect(screen.getByRole('status', { name: 'Loading deliverability' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading the deliverability trend' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Checking sending domains' })).toBeTruthy();
  });

  it('keeps period and filter controls in the empty state', async () => {
    h.trend = trendFixture([]);
    render(<DeliverabilityPage />);

    await screen.findByText('No recorded activity in this period');
    expect(screen.getByLabelText('Period')).toBeTruthy();
    expect(screen.getByLabelText('Stream')).toBeTruthy();
  });

  it('shows observed zero as 0 and the rate as an unavailable gap', async () => {
    h.health = healthFixture({
      emailMarketing: { ...zeroRates },
      emailTransactional: { ...zeroRates },
      smsMarketing: { ...zeroRates },
      smsTransactional: { ...zeroRates },
    });
    h.trend = trendFixture([point('2026-11-06', 0, 0, 0, null, null)]);
    render(<DeliverabilityPage />);

    await screen.findByText('Zero sends in every window');
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No denominator available').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('keeps a successful trend visible when health fails', async () => {
    h.healthError = new Error('health unavailable');
    render(<DeliverabilityPage />);

    await screen.findByText(/load the health summary/);
    expect(screen.getByText(/Successful trend and DNS sections remain visible/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Bounce rate · last 7 complete days/ })).toBeTruthy();
  });

  it('returns focus to the trend heading after Retry succeeds', async () => {
    h.trendError = new Error('trend failed');
    render(<DeliverabilityPage />);
    await screen.findByText(/load the trend/);

    h.trendError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Bounce and complaint trend' })));
  });

  it('removes old health values when a refresh fails instead of showing them as current', async () => {
    render(<DeliverabilityPage />);
    await screen.findByText('Selected stream · E-mail · marketing');

    h.healthError = new Error('refresh failed');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rates' }));
    await screen.findByText(/load the health summary/);
    expect(screen.queryByText('Selected stream · E-mail · marketing')).toBeNull();
    expect(screen.queryByText('Sample 2,000 / minimum 200')).toBeNull();
  });

  it('keeps health and trend visible when DNS fails, and retries only DNS', async () => {
    h.domainsError = new Error('lookup failed');
    render(<DeliverabilityPage />);

    await screen.findByText('DNS checks unavailable');
    expect(screen.getByText('Delivery health · rolling 7 days')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Bounce rate · last 7 complete days/ })).toBeTruthy();
    const alert = screen.getByText('DNS checks unavailable').closest('[role="alert"]');
    expect(alert).not.toBeNull();
    fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(domainCalls()).toHaveLength(2));
    expect(healthCalls()).toHaveLength(1);
    expect(trendCalls()).toHaveLength(1);
  });

  it('distinguishes not-found from empty', async () => {
    h.healthError = new Error('deliverability not found');
    render(<DeliverabilityPage />);

    await screen.findByText('This item is not available at this address');
    expect(screen.queryByText('No recorded activity in this period')).toBeNull();
  });

  it('never lets a stale trend response replace a newer stream selection', async () => {
    const resolvers: Array<(value: Trend) => void> = [];
    h.trendHandler = () => new Promise<Trend>((resolve) => resolvers.push(resolve));
    render(<DeliverabilityPage />);
    await waitFor(() => expect(resolvers).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Stream'), { target: { value: 'sms.marketing' } });
    await waitFor(() => expect(resolvers).toHaveLength(2));

    await act(async () => {
      resolvers[1]?.(trendFixture(defaultPoints, { timeZone: 'Europe/Copenhagen' }));
    });
    await screen.findByText(/Window bounds use Europe\/Copenhagen/);
    await act(async () => {
      resolvers[0]?.(trendFixture(defaultPoints, { timeZone: 'UTC' }));
    });
    expect(screen.getByText(/Window bounds use Europe\/Copenhagen/)).toBeTruthy();
    expect(screen.queryByText(/Window bounds use UTC/)).toBeNull();
  });

  it('states that these operational reads carry no suppression field', async () => {
    render(<DeliverabilityPage />);
    await screen.findByText(/no k-suppression field/);
  });
});
