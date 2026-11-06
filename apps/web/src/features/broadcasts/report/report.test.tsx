import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceTimeZone } from '../../../ui/time';
import { BroadcastReport } from '../BroadcastReport';
import { lastThirtyLocalDays, localDayPeriod, periodDateLabel } from '../period';
import { SERIES_MEASURES, TOTAL_MEASURES } from './model';

const broadcast = `bct_${'a'.repeat(32)}`;
const campaignId = `cmp_${'b'.repeat(32)}`;
const campaignBId = `cmp_${'c'.repeat(32)}`;

type MockInput = {
  artifactId?: string;
  version?: number;
  dimensions?: string[];
  campaignId?: string;
  from?: string;
  to?: string;
};

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: MockInput }[],
  canArtifacts: true,
  canProfiles: true,
  totals: null as unknown,
  series: null as unknown,
  totalsError: null as Error | null,
  seriesError: null as Error | null,
  pendingAnalytics: false,
  campaigns: [] as unknown[],
  artifacts: new Map<string, unknown>(),
  holdout: {} as Record<string, unknown>,
  holdoutError: null as Error | null,
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: MockInput) => {
        h.calls.push({ name, input });
        if (name === 'analytics.query') {
          if (h.pendingAnalytics) return new Promise(() => {});
          if (input.dimensions?.length) {
            if (h.seriesError) throw h.seriesError;
            return h.series;
          }
          if (h.totalsError) throw h.totalsError;
          return h.totals;
        }
        if (name === 'campaigns.of') return { campaigns: h.campaigns };
        if (name === 'artifacts.get') {
          const artifact = h.artifacts.get(input.artifactId ?? '');
          if (!artifact) throw new Error(`No campaign ${input.artifactId}`);
          const typed = artifact as { version: { number: number; state: string; content: unknown } };
          if (input.version && typed.version.number !== input.version) {
            return { ...typed, version: { ...typed.version, number: input.version, state: 'published' } };
          }
          return typed;
        }
        if (name === 'campaigns.holdoutResult') {
          if (h.holdoutError) throw h.holdoutError;
          const result = h.holdout[input.campaignId ?? ''];
          if (!result) throw new Error(`No holdout for ${input.campaignId}`);
          return result;
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

const session = () => ({
  can: (permission: string) => (permission === 'artifacts:read' ? h.canArtifacts : permission === 'profiles:read' ? h.canProfiles : true),
  workspace: { id: 'ws_1' },
  user: { id: 'u1' },
});

vi.mock('../../../app/session', () => ({
  useSession: session,
  useWorkspace: session,
}));

// The frozen chart primitive still renders its accessible table; the plot itself needs a browser.
vi.mock('../../../components/Chart', () => ({ Chart: () => null }));

const counts: Record<string, number | null> = {
  'email.sent': 12104,
  'email.delivered': 11826,
  'email.bounced': 218,
  'email.complained': 7,
  'email.opened': 3510,
  'email.clicked': 981,
  'email.unsubscribed': 31,
  'email.open_rate': 3510 / 11826,
  'email.click_rate': 981 / 11826,
  'email.unsubscribe_rate': 31 / 11826,
};

const meta = {
  timeZone: 'UTC',
  currency: null,
  from: '2026-10-30T00:00:00.000Z',
  to: '2026-11-05T23:59:59.999Z',
  freshness: '2026-11-05T22:18:00.000Z',
  suppressed: 0,
  k: 5,
  notes: [],
};

const totalsResult = (overrides: Record<string, number | null> = {}, suppressed = 0) => {
  const values = { ...counts, ...overrides };
  return {
    columns: TOTAL_MEASURES.map((name) => ({
      name,
      kind: 'measure',
      unit: name.endsWith('_rate') ? 'ratio' : 'count',
    })),
    rows: [TOTAL_MEASURES.map((name) => values[name] ?? null)],
    meta: { ...meta, suppressed },
  };
};

const seriesDays = [
  { day: '2026-10-30', sent: 1200, delivered: 1170, opened: 640, clicked: 100, unsubscribed: 5 },
  { day: '2026-10-31', sent: 1400, delivered: 1380, opened: 930, clicked: 170, unsubscribed: 8 },
  { day: '2026-11-01', sent: 1500, delivered: 1470, opened: 750, clicked: null, unsubscribed: 7 },
  { day: '2026-11-02', sent: 1300, delivered: 1270, opened: 470, clicked: 180, unsubscribed: 4 },
  { day: '2026-11-03', sent: 1100, delivered: 1080, opened: 350, clicked: 140, unsubscribed: 3 },
  { day: '2026-11-04', sent: 1000, delivered: 970, opened: 270, clicked: 90, unsubscribed: 2 },
  { day: '2026-11-05', sent: 900, delivered: 880, opened: 200, clicked: 70, unsubscribed: 2 },
];

const seriesResult = (days = seriesDays, suppressed = 0) => ({
  columns: [
    { name: 'day', kind: 'dimension' },
    ...SERIES_MEASURES.map((name) => ({
      name,
      kind: 'measure',
      unit: 'count',
    })),
  ],
  rows: days.map((day) => [day.day, day.sent, day.delivered, day.opened, day.clicked, day.unsubscribed]),
  meta: { ...meta, suppressed },
});

const campaign = (overrides: Record<string, unknown> = {}) => ({
  id: campaignId,
  name: 'Audience quality campaign',
  role: 'primary',
  goal: { kind: 'conversion', event: 'Signup', target: null, attributionDays: 7 },
  utmCampaign: null,
  ...overrides,
});

const campaignArtifact = (
  content: unknown = { controlGroup: { percent: 10, minSampleSize: 100 } },
  overrides: Record<string, unknown> = {},
) => ({
  id: campaignId,
  type: 'campaign',
  name: 'Audience quality campaign',
  latestVersion: 2,
  publishedVersion: 2,
  version: {
    number: 2,
    state: 'published',
    content,
  },
  layout: null,
  references: [],
  ...overrides,
});

const holdoutResult = (overrides: Record<string, unknown> = {}) => ({
  campaignId,
  goal: { kind: 'conversion', event: 'Signup', attributionDays: 7 },
  controlGroup: { percent: 10, minSampleSize: 100, hashVersion: 'v1' },
  from: '2026-10-30T00:00:00.000Z',
  to: '2026-11-05T23:59:59.999Z',
  control: {
    entered: 800,
    converted: 40,
    unsubscribed: 0,
    conversionRate: 0.05,
    unsubscribeRate: 0,
    revenue: { EUR: 2000 },
  },
  treatment: {
    entered: 7200,
    converted: 389,
    unsubscribed: 31,
    conversionRate: 389 / 7200,
    unsubscribeRate: 31 / 7200,
    revenue: { EUR: 19450, USD: 500 },
  },
  absoluteLift: 0.004,
  relativeLift: 0.0808,
  ci95: [0.001, 0.018],
  minSampleSizeMet: true,
  verdict: 'treatment_better',
  note: 'Treatment converted more often than control.',
  ...overrides,
});

const useCampaign = (
  result = holdoutResult(),
  membership = campaign(),
  content: unknown = { controlGroup: { percent: 10, minSampleSize: 100 } },
) => {
  h.campaigns = [membership];
  h.artifacts.set(membership.id as string, campaignArtifact(content, { id: membership.id, name: membership.name }));
  h.holdout[membership.id as string] = result;
};

const renderReport = (active = true) => render(<BroadcastReport artifactId={broadcast} active={active} />);

const analyticsCalls = () => h.calls.filter((call) => call.name === 'analytics.query');
const totalsCalls = () => analyticsCalls().filter((call) => (call.input.dimensions?.length ?? 0) === 0);
const seriesCalls = () => analyticsCalls().filter((call) => call.input.dimensions?.[0] === 'day');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
  setWorkspaceTimeZone('UTC');
  h.calls.length = 0;
  h.canArtifacts = true;
  h.canProfiles = true;
  h.totals = totalsResult();
  h.series = seriesResult();
  h.totalsError = null;
  h.seriesError = null;
  h.pendingAnalytics = false;
  h.campaigns = [];
  h.artifacts.clear();
  h.holdout = {};
  h.holdoutError = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('broadcast report period (#500)', () => {
  it('uses calendar-day periods and inclusive query bounds across DST', () => {
    const seven = localDayPeriod(7, new Date('2026-11-06T12:00:00Z'), 'America/New_York');
    expect(seven.fromDate).toBe('2026-10-30');
    expect(seven.toDate).toBe('2026-11-05');
    expect(seven.nextDate).toBe('2026-11-06');
    expect(seven.from).toBe('2026-10-30T04:00:00.000Z');
    expect(seven.nextMidnight).toBe('2026-11-06T05:00:00.000Z');
    expect(seven.to).toBe('2026-11-06T04:59:59.999Z');

    const thirty = lastThirtyLocalDays(new Date('2026-11-06T12:00:00Z'), 'UTC');
    expect(thirty.fromDate).toBe('2026-10-07');
    expect(thirty.toDate).toBe('2026-11-05');
    expect(thirty.from).toBe('2026-10-07T00:00:00.000Z');
    expect(thirty.to).toBe('2026-11-05T23:59:59.999Z');
    expect(periodDateLabel(thirty)).toBe('7 Oct–5 Nov 2026');
  });
});

describe('broadcast report reads (#500)', () => {
  it('runs exactly the totals and series reads for the default seven complete days', async () => {
    renderReport();
    await screen.findAllByText('12,104');

    await waitFor(() => expect(analyticsCalls()).toHaveLength(2));
    expect(totalsCalls()).toHaveLength(1);
    expect(seriesCalls()).toHaveLength(1);
    expect(totalsCalls()[0]!.input).toEqual({
      measures: [...TOTAL_MEASURES],
      dimensions: [],
      from: '2026-10-30T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
      filters: { broadcast },
    });
    expect(seriesCalls()[0]!.input).toEqual({
      measures: [...SERIES_MEASURES],
      dimensions: ['day'],
      from: '2026-10-30T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
      filters: { broadcast },
    });
    expect(h.calls.filter((call) => call.name === 'campaigns.of')).toEqual([{ name: 'campaigns.of', input: { artifactId: broadcast } }]);
    expect(screen.getAllByText(/30 Oct–5 Nov 2026 · UTC/).length).toBeGreaterThan(0);
    expect(screen.getByText('981 / 11,826')).toBeTruthy();
    expect(screen.getByText('0.3% of delivered people')).toBeTruthy();
    expect(screen.getAllByText(/Latest event in period:/).length).toBeGreaterThan(0);
  });

  it('does not load reads while the Report tab is inactive', async () => {
    renderReport(false);
    expect(h.calls).toHaveLength(0);
    expect(screen.queryByText('Sent people')).toBeNull();
  });

  it('skips analytics and campaign reads for a role without artifacts:read', async () => {
    h.canArtifacts = false;
    renderReport();
    await screen.findByText('Report restricted');
    expect(screen.getByText('Your role needs artifacts:read. No analytics have been loaded.')).toBeTruthy();
    expect(h.calls).toHaveLength(0);
  });

  it('changes every read when the period changes', async () => {
    renderReport();
    await screen.findAllByText('12,104');
    await waitFor(() => expect(analyticsCalls()).toHaveLength(2));

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30' } });
    await waitFor(() => expect(analyticsCalls()).toHaveLength(4));
    expect(totalsCalls().map((call) => call.input.from)).toEqual(['2026-10-30T00:00:00.000Z', '2026-10-07T00:00:00.000Z']);
    expect(seriesCalls().map((call) => call.input.to)).toEqual(['2026-11-05T23:59:59.999Z', '2026-11-05T23:59:59.999Z']);
    expect(screen.getAllByText(/7 Oct–5 Nov 2026 · UTC/).length).toBeGreaterThan(0);
  });
});

describe('broadcast report data states (#500)', () => {
  it('shows section skeletons while the event reads are loading', async () => {
    h.pendingAnalytics = true;
    renderReport();
    await waitFor(() => expect(analyticsCalls()).toHaveLength(2));
    expect(document.querySelectorAll('section[aria-busy="true"]').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('12,104')).toBeNull();
  });

  it('keeps a totals failure local and retries only that read', async () => {
    h.totalsError = new Error('analytics unavailable');
    renderReport();
    await screen.findByText('Performance unavailable');
    expect(screen.getByText('Charts unavailable until the event read succeeds.')).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(4);
    // The independent series read still renders its charts.
    expect(screen.getByRole('heading', { name: 'Tracked engagement over time' })).toBeTruthy();

    const before = totalsCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(totalsCalls().length).toBe(before + 1));
  });

  it('names a complete all-zero period and never fabricates a rate', async () => {
    h.totals = totalsResult({
      'email.sent': 0,
      'email.delivered': 0,
      'email.bounced': 0,
      'email.complained': 0,
      'email.opened': 0,
      'email.clicked': 0,
      'email.unsubscribed': 0,
      'email.open_rate': null,
      'email.click_rate': null,
      'email.unsubscribe_rate': null,
    });
    h.series = seriesResult([], 0);
    renderReport();
    await screen.findByText('No recorded events in this period');
    expect(screen.getAllByText('No delivered people to divide by').length).toBeGreaterThan(0);
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('withholds every suppressed tile and keeps the minimum group size', async () => {
    h.totals = totalsResult(
      {
        'email.sent': null,
        'email.delivered': null,
        'email.opened': null,
        'email.clicked': null,
        'email.unsubscribed': null,
        'email.open_rate': null,
        'email.click_rate': null,
        'email.unsubscribe_rate': null,
      },
      3,
    );
    h.series = seriesResult([], 3);
    renderReport();
    await waitFor(() => expect(screen.getAllByText('Fewer than 5 people').length).toBeGreaterThanOrEqual(4));
    expect(screen.getAllByText(/3 rows suppressed below 5 people/).length).toBeGreaterThan(0);
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('keeps delivery when the campaign read fails', async () => {
    h.campaigns = [campaign()];
    // No artifact in the map: the campaign section reports its own failure.
    renderReport();
    await screen.findByText('Audience quality campaign holdout unavailable');
    expect(screen.getAllByText('12,104').length).toBeGreaterThan(0);
  });
});

describe('broadcast report holdout (#500)', () => {
  it('shows a campaign-wide holdout with its interval, rates and revenue per currency', async () => {
    useCampaign();
    renderReport();
    const heading = await screen.findByRole('heading', { name: /Audience quality campaign · Campaign-wide holdout/ });
    expect(heading).toBeTruthy();
    await screen.findByText('Treatment better');
    expect(screen.getByText(/95% interval \+0\.1 pp to \+1\.8 pp/)).toBeTruthy();
    expect(screen.getByText(/\+0\.4 pp/)).toBeTruthy();
    expect(screen.getByText(/\+8\.1% relative lift/)).toBeTruthy();
    expect(screen.getByText(/€2,000/)).toBeTruthy();
    expect(screen.getByText(/€19,450/)).toBeTruthy();
    expect(screen.getByText(/Campaign-wide; includes other sending members/)).toBeTruthy();
    expect(h.calls.filter((call) => call.name === 'campaigns.holdoutResult')[0]!.input).toEqual({
      campaignId,
      from: '2026-10-30T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
    });
  });

  it('calls an insufficient sample insufficient even when the point estimate moves', async () => {
    useCampaign(holdoutResult({ minSampleSizeMet: false }));
    renderReport();
    await screen.findByText('Insufficient sample');
    expect(screen.getAllByText(/Minimum sample met|Insufficient sample/).length).toBeGreaterThan(0);
  });

  it('calls an interval containing zero inconclusive', async () => {
    useCampaign(holdoutResult({ verdict: 'treatment_better', ci95: [-0.01, 0.02] }));
    renderReport();
    await screen.findByText('Inconclusive');
  });

  it('keeps an entered-zero arm unavailable instead of zero', async () => {
    useCampaign(
      holdoutResult({
        control: {
          entered: 0,
          converted: 0,
          unsubscribed: 0,
          conversionRate: 0,
          unsubscribeRate: 0,
          revenue: {},
        },
      }),
    );
    renderReport();
    const table = await screen.findByRole('table', { name: /holdout by arm/ });
    expect(within(table).getAllByText('Unavailable').length).toBeGreaterThanOrEqual(3);
    expect(within(table).queryByText('0%')).toBeNull();
  });

  it('does not query a campaign without a published control group', async () => {
    useCampaign(holdoutResult(), campaign(), {});
    renderReport();
    await screen.findByText('No campaign control group');
    expect(h.calls.some((call) => call.name === 'campaigns.holdoutResult')).toBe(false);
  });

  it('asks for a goal event and does not query a result without one', async () => {
    useCampaign(holdoutResult(), campaign({ goal: { kind: 'conversion', event: null, target: null, attributionDays: 7 } }), {
      controlGroup: { percent: 10, minSampleSize: 100 },
    });
    renderReport();
    await screen.findByText('Set a campaign goal event to measure uplift.');
    expect(h.calls.some((call) => call.name === 'campaigns.holdoutResult')).toBe(false);
  });

  it('keeps multiple controlled campaigns as separate sections', async () => {
    h.campaigns = [campaign(), campaign({ id: campaignBId, name: 'Second campaign' })];
    h.artifacts.set(campaignId, campaignArtifact());
    h.artifacts.set(campaignBId, campaignArtifact());
    h.holdout[campaignId] = holdoutResult();
    h.holdout[campaignBId] = holdoutResult({ campaignId: campaignBId, verdict: 'no_clear_difference' });
    renderReport();
    await screen.findByRole('heading', { name: /Audience quality campaign · Campaign-wide holdout/ });
    await screen.findByRole('heading', { name: /Second campaign · Campaign-wide holdout/ });
    expect(h.calls.filter((call) => call.name === 'campaigns.holdoutResult')).toHaveLength(2);
    expect(screen.queryByText(/combined|merged/i)).toBeNull();
  });
});

describe('broadcast report accessibility (#500)', () => {
  it('exposes complete day tables independently of the charts', async () => {
    renderReport();
    await screen.findAllByText('12,104');

    const summaries = screen.getAllByText('Show data table');
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    for (const summary of summaries) fireEvent.click(summary);

    const engagement = screen.getByRole('table', { name: 'Tracked engagement over time' });
    expect(within(engagement).getByText('Period')).toBeTruthy();
    expect(within(engagement).getByText('Tracked opens (people)')).toBeTruthy();
    expect(within(engagement).getByText('Clicks (people)')).toBeTruthy();
    expect(within(engagement).getByText('30 Oct')).toBeTruthy();
    expect(within(engagement).getByText('640 people')).toBeTruthy();
    // A null daily cell is a gap, not an observed zero.
    expect(within(engagement).getAllByText('—').length).toBeGreaterThan(0);

    const unsubscribes = screen.getByRole('table', { name: 'Unsubscribes over time' });
    expect(within(unsubscribes).getByText('30 Oct')).toBeTruthy();
    expect(within(unsubscribes).getByText('5')).toBeTruthy();
    const delivery = screen.getByRole('table', { name: 'Delivery events · people' });
    expect(within(delivery).getByText('Sent')).toBeTruthy();

    expect(screen.getByRole('figure', { name: 'Tracked engagement over time' })).toBeTruthy();
  });

  it('never renders a raw link URL in the B4 notice', async () => {
    renderReport();
    await screen.findAllByText('12,104');
    expect(screen.getByText('Top links unavailable')).toBeTruthy();
    expect(screen.getByText('Safe link labels are not available for this report.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Message activity' }).getAttribute('href')).toBe('/insights/messages');
    expect(document.body.textContent).not.toMatch(/https?:\/\//);
  });

  it('omits the Message activity link without profiles:read', async () => {
    h.canProfiles = false;
    renderReport();
    await screen.findAllByText('12,104');
    expect(screen.queryByRole('link', { name: 'Open Message activity' })).toBeNull();
    expect(screen.getByText('Top links unavailable')).toBeTruthy();
  });
});
