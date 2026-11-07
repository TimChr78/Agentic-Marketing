import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceTimeZone } from '../../../ui/time';
import { CampaignEvaluation } from '../../artifacts/CampaignEvaluation';
import { CampaignHoldoutCard } from '../CampaignHoldoutCard';
import { CampaignEvaluationTab } from './CampaignEvaluationTab';

type ApiCall = { name: string; input: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as ApiCall[],
  canArtifacts: true,
  summary: null as unknown,
  summaryError: null as Error | null,
  summaryQueue: [] as unknown[],
  holdout: null as unknown,
  holdoutError: null as Error | null,
  artifacts: new Map<string, unknown>(),
  published: new Map<string, unknown>(),
  artifactError: null as Error | null,
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'analytics.campaignSummary') {
          if (h.summaryError) throw h.summaryError;
          const next = h.summaryQueue.shift();
          const value = next ?? h.summary;
          return typeof value === 'function' ? await (value as (i: Record<string, unknown>) => unknown)(input) : value;
        }
        if (name === 'campaigns.holdoutResult') {
          if (h.holdoutError) throw h.holdoutError;
          return typeof h.holdout === 'function' ? await (h.holdout as (i: Record<string, unknown>) => unknown)(input) : h.holdout;
        }
        if (name === 'artifacts.get') {
          if (h.artifactError) throw h.artifactError;
          const id = String(input.artifactId ?? '');
          const artifact = h.artifacts.get(id);
          if (!artifact) throw new Error(`No artifact ${id}`);
          if (typeof input.version === 'number') {
            const version = (artifact as { version: Record<string, unknown> }).version;
            return {
              ...(artifact as object),
              version: {
                ...version,
                number: input.version,
                state: 'published',
                content: h.published.get(id) ?? version.content,
              },
            };
          }
          return artifact;
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useWorkspace: () => ({
    can: (permission: string) => (permission === 'artifacts:read' ? h.canArtifacts : true),
    workspace: { id: 'ws_1' },
    user: { id: 'u1' },
  }),
}));

const campaignId = `cmp_${'a'.repeat(32)}`;
const journeyId = `jrn_${'b'.repeat(32)}`;
const broadcastId = `bct_${'c'.repeat(32)}`;

const meta = {
  timeZone: 'UTC',
  currency: 'EUR',
  from: '2026-10-30T00:00:00.000Z',
  to: '2026-11-05T23:59:59.999Z',
  freshness: '2026-11-05T21:42:00.000Z',
  suppressed: 0,
  k: 5,
  notes: ['Campaign conversions are first touch.'],
};

const goal = { kind: 'conversion', event: 'purchased', target: 3000, attributionDays: 7 };

function journeyHoldout(overrides: Record<string, unknown> = {}) {
  return {
    journeyId,
    name: 'Welcome series',
    controlGroup: { percent: 10, minSampleSize: 100, hashVersion: 'v1' },
    control: { entered: 400, converted: 20, unsubscribed: 0, conversionRate: 0.05, unsubscribeRate: 0 },
    treatment: { entered: 2400, converted: 144, unsubscribed: 12, conversionRate: 0.06, unsubscribeRate: 0.005 },
    absoluteLift: 0.01,
    relativeLift: 0.2,
    ci95: [-0.014, 0.034],
    minSampleSizeMet: true,
    verdict: 'no_clear_difference',
    note: 'The interval includes zero; no clear difference.',
    ...overrides,
  };
}

function summaryMeasured(overrides: Record<string, unknown> = {}) {
  return {
    campaignId,
    name: 'Autumn audience quality',
    state: 'measured',
    goal,
    headline: {
      recipients: 2400,
      delivered: 2400,
      clickers: 192,
      unsubscribers: 12,
      complaintRate: 0.001,
      unsubscribeRate: 0.005,
      converters: 144,
      conversionRate: 0.06,
      revenue: [{ currency: 'EUR', amount: 7200 }],
      revenuePerRecipient: [{ currency: 'EUR', amount: 3 }],
      targetProgress: 0.048,
    },
    funnel: [
      { step: 'recipients', count: 2400, stepRate: null, shareOfRecipients: 1 },
      { step: 'delivered', count: 2400, stepRate: 1, shareOfRecipients: 1 },
      { step: 'clicked', count: 192, stepRate: 0.08, shareOfRecipients: 0.08 },
      { step: 'converted', count: 144, stepRate: 0.75, shareOfRecipients: 0.06 },
    ],
    members: [
      {
        artifactId: broadcastId,
        name: 'Weekly Signal',
        type: 'broadcast',
        role: 'primary',
        sent: 1600,
        delivered: 1600,
        clickRate: 0.08,
        unsubscribeRate: 0.005,
        converters: 96,
      },
      {
        artifactId: journeyId,
        name: 'Welcome series',
        type: 'journey',
        role: 'follow_up',
        sent: 900,
        delivered: 900,
        clickRate: 0.08,
        unsubscribeRate: 0.005,
        converters: 48,
      },
    ],
    holdouts: [journeyHoldout()],
    meta: { ...meta },
    ...overrides,
  };
}

function notStarted(overrides: Record<string, unknown> = {}) {
  return {
    campaignId,
    name: 'Autumn audience quality',
    state: 'not_started',
    goal,
    readiness: {
      published: true,
      membersPublished: false,
      sendingMembers: 3,
      publishedSendingMembers: 2,
      sendingMembersScheduled: false,
    },
    meta: { ...meta, freshness: null },
    ...overrides,
  };
}

function campaignHoldout(overrides: Record<string, unknown> = {}) {
  return {
    campaignId,
    goal: { kind: 'conversion', event: 'purchased', attributionDays: 7 },
    controlGroup: { percent: 10, minSampleSize: 200, hashVersion: 'v1' },
    from: meta.from,
    to: meta.to,
    control: {
      entered: 400,
      converted: 20,
      unsubscribed: 0,
      conversionRate: 0.05,
      unsubscribeRate: 0,
      revenue: { EUR: 2000 },
    },
    treatment: {
      entered: 2400,
      converted: 144,
      unsubscribed: 12,
      conversionRate: 0.06,
      unsubscribeRate: 0.005,
      revenue: { EUR: 19450, USD: 500 },
    },
    absoluteLift: 0.01,
    relativeLift: 0.2,
    ci95: [-0.014, 0.034],
    minSampleSizeMet: true,
    verdict: 'no_clear_difference',
    note: 'The interval includes zero; no clear difference.',
    ...overrides,
  };
}

function campaignArtifact(
  content: unknown = { goal, controlGroup: { percent: 10, minSampleSize: 200 } },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: campaignId,
    type: 'campaign',
    name: 'Autumn audience quality',
    latestVersion: 2,
    publishedVersion: 2,
    version: { number: 2, state: 'published', content },
    layout: null,
    references: [],
    ...overrides,
  };
}

const summaryCalls = () => h.calls.filter((call) => call.name === 'analytics.campaignSummary');
const holdoutCalls = () => h.calls.filter((call) => call.name === 'campaigns.holdoutResult');
const artifactCalls = () => h.calls.filter((call) => call.name === 'artifacts.get');

function renderTab(overrides: { active?: boolean; artifact?: unknown } = {}) {
  return render(
    <CampaignEvaluationTab
      campaignId={campaignId}
      artifact={(overrides.artifact as ReturnType<typeof campaignArtifact>) ?? campaignArtifact()}
      active={overrides.active ?? true}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
  setWorkspaceTimeZone('UTC');
  h.calls.length = 0;
  h.canArtifacts = true;
  h.summaryError = null;
  h.summaryQueue.length = 0;
  h.holdoutError = null;
  h.artifactError = null;
  h.summary = summaryMeasured();
  h.holdout = campaignHoldout();
  h.artifacts.clear();
  h.published.clear();
  const artifact = campaignArtifact();
  h.artifacts.set(campaignId, artifact);
  h.published.set(campaignId, artifact.version.content);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('campaign roll-up reads (#511)', () => {
  it('reads exactly one summary and one campaign holdout, with no per-member fan-out', async () => {
    h.summary = summaryMeasured({
      members: Array.from({ length: 6 }, (_, index) => ({
        artifactId: `bct_${index.toString(16).padStart(32, '0')}`,
        name: `Member ${index + 1}`,
        type: 'broadcast',
        role: 'primary',
        sent: 100,
        delivered: 100,
        clickRate: 0.05,
        unsubscribeRate: 0,
        converters: 2,
      })),
    });

    renderTab();
    await screen.findByText('Member 1');

    await waitFor(() => expect(summaryCalls()).toHaveLength(1));
    expect(holdoutCalls()).toHaveLength(1);
    expect(h.calls.map((call) => call.name).sort()).toEqual(['analytics.campaignSummary', 'campaigns.holdoutResult']);
    expect(summaryCalls()[0]!.input).toEqual({
      campaignId,
      from: '2026-10-30T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
    });
    expect(holdoutCalls()[0]!.input).toEqual({
      campaignId,
      from: '2026-10-30T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
    });
  });

  it('reuses the host published definition and adds one pinned read only for a newer draft', async () => {
    const draft = campaignArtifact(
      { goal, controlGroup: { percent: 10, minSampleSize: 200 } },
      { latestVersion: 3, version: { number: 3, state: 'draft', content: {} } },
    );
    h.artifacts.set(campaignId, draft);

    renderTab({ artifact: draft });
    await screen.findAllByText('2,400');
    // The holdout chain (pinned definition, then result) settles independently of the summary.
    await waitFor(() => expect(holdoutCalls()).toHaveLength(1));

    expect(artifactCalls()).toHaveLength(1);
    expect(artifactCalls()[0]!.input).toEqual({ artifactId: campaignId, version: 2 });
    expect(holdoutCalls()).toHaveLength(1);
  });

  it('reads the campaign definition itself when the host does not supply it', async () => {
    const draft = campaignArtifact(
      { goal, controlGroup: { percent: 10, minSampleSize: 200 } },
      { latestVersion: 3, version: { number: 3, state: 'draft', content: {} } },
    );
    h.artifacts.set(campaignId, draft);

    render(<CampaignHoldoutCard campaignId={campaignId} />);
    await screen.findByText('Campaign-wide holdout');
    await waitFor(() => expect(holdoutCalls()).toHaveLength(1));

    expect(artifactCalls().map((call) => call.input)).toEqual([{ artifactId: campaignId }, { artifactId: campaignId, version: 2 }]);
    expect(holdoutCalls()).toHaveLength(1);
  });

  it('does not read while the tab is inactive', () => {
    renderTab({ active: false });
    expect(h.calls).toEqual([]);
  });

  it('issues zero reads for a role without artifacts:read', async () => {
    h.canArtifacts = false;
    render(<CampaignEvaluation campaignId={campaignId} />);
    await screen.findByText('Results restricted');
    expect(h.calls).toEqual([]);
  });

  it('skips the holdout read without a published control group', async () => {
    const artifact = campaignArtifact({ goal });
    h.artifacts.set(campaignId, artifact);
    h.published.set(campaignId, artifact.version.content);

    renderTab({ artifact });
    await screen.findByText('No campaign control group');

    expect(summaryCalls()).toHaveLength(1);
    expect(holdoutCalls()).toHaveLength(0);
    expect(artifactCalls()).toHaveLength(0);
  });

  it('skips the holdout read without a goal event', async () => {
    const artifact = campaignArtifact({
      controlGroup: { percent: 10, minSampleSize: 200 },
      goal: { kind: 'engagement', attributionDays: 7 },
    });
    h.artifacts.set(campaignId, artifact);
    h.published.set(campaignId, artifact.version.content);

    renderTab({ artifact });
    await screen.findByText('Set a campaign goal event');

    expect(summaryCalls()).toHaveLength(1);
    expect(holdoutCalls()).toHaveLength(0);
    expect(artifactCalls()).toHaveLength(0);
  });

  it('changes both reads together when the period changes', async () => {
    h.summary = (input: Record<string, unknown>) => summaryMeasured({ meta: { ...meta, from: String(input.from), to: String(input.to) } });
    renderTab();
    await screen.findAllByText('2,400');
    await waitFor(() => expect(summaryCalls()).toHaveLength(1));

    const select = screen.getByLabelText('Period');
    select.focus();
    fireEvent.change(select, { target: { value: '30' } });

    await waitFor(() => expect(summaryCalls()).toHaveLength(2));
    expect(holdoutCalls()).toHaveLength(2);
    expect(summaryCalls()[1]!.input.from).toBe('2026-10-07T00:00:00.000Z');
    expect(summaryCalls()[1]!.input.to).toBe('2026-11-05T23:59:59.999Z');
    expect(holdoutCalls()[1]!.input.from).toBe('2026-10-07T00:00:00.000Z');
    expect(holdoutCalls()[1]!.input.to).toBe('2026-11-05T23:59:59.999Z');
    expect(document.activeElement).toBe(select);
    expect(screen.getAllByText(/7 Oct–5 Nov 2026 · UTC/).length).toBeGreaterThan(0);
  });

  it('refreshes the same reads without changing the period', async () => {
    renderTab();
    await screen.findAllByText('2,400');
    await waitFor(() => expect(summaryCalls()).toHaveLength(1));

    const refresh = screen.getByRole('button', { name: 'Refresh' });
    refresh.focus();
    fireEvent.click(refresh);

    await waitFor(() => expect(summaryCalls()).toHaveLength(2));
    expect(summaryCalls()[1]!.input).toEqual(summaryCalls()[0]!.input);
    expect(holdoutCalls()[1]!.input).toEqual(holdoutCalls()[0]!.input);
    expect(document.activeElement).toBe(refresh);
  });
});

describe('campaign roll-up currency separation (#511)', () => {
  it('shows every currency separately and never sums or averages across them', async () => {
    h.summary = summaryMeasured({
      headline: {
        ...summaryMeasured().headline,
        revenue: [
          { currency: 'EUR', amount: 7200 },
          { currency: 'USD', amount: 1800 },
        ],
        revenuePerRecipient: [
          { currency: 'EUR', amount: 3 },
          { currency: 'USD', amount: 0.75 },
        ],
        targetProgress: null,
      },
      meta: { ...meta, currency: null },
    });
    h.holdout = campaignHoldout({
      control: { entered: 400, converted: 20, unsubscribed: 0, conversionRate: 0.05, unsubscribeRate: 0, revenue: { EUR: 2000 } },
      treatment: {
        entered: 2400,
        converted: 144,
        unsubscribed: 12,
        conversionRate: 0.06,
        unsubscribeRate: 0.005,
        revenue: { EUR: 19450, USD: 500 },
      },
    });

    renderTab();
    await screen.findByText('Revenue · EUR');
    await screen.findByText('Campaign-wide holdout');

    expect(screen.getByText('Revenue · EUR')).toBeTruthy();
    expect(screen.getByText('Revenue · USD')).toBeTruthy();
    expect(screen.getByText('€7,200')).toBeTruthy();
    expect(screen.getByText('$1,800')).toBeTruthy();
    expect(screen.getByText('€19,450')).toBeTruthy();
    expect(screen.getByText('$500')).toBeTruthy();
    expect(screen.getByText('Amounts stay separate per currency; no combined total, average or chart.')).toBeTruthy();
    expect(screen.getByText('Revenue is not combined across currencies.')).toBeTruthy();
    expect(screen.queryByText('9,000')).toBeNull();
    expect(screen.queryByText('€9,000')).toBeNull();
    expect(screen.queryByText('$2,300')).toBeNull();
  });

  it('keeps target progress unavailable when currencies cannot be combined', async () => {
    h.summary = summaryMeasured({
      headline: {
        ...summaryMeasured().headline,
        revenue: [
          { currency: 'EUR', amount: 7200 },
          { currency: 'USD', amount: 1800 },
        ],
        revenuePerRecipient: [],
        targetProgress: null,
      },
      meta: { ...meta, currency: null },
      goal: { ...goal, kind: 'revenue' },
    });

    renderTab();
    await screen.findByText('Progress unavailable · multiple currencies cannot be combined');
    expect(screen.queryByText('0%')).toBeNull();
  });
});

describe('campaign roll-up holdouts (#511)', () => {
  it.each([
    ['not_enough_data', false, null, 'Insufficient sample'],
    ['no_clear_difference', true, [-0.014, 0.034], 'Inconclusive'],
    ['treatment_better', true, [0.001, 0.018], 'Treatment better'],
    ['treatment_worse', true, [-0.03, -0.001], 'Treatment worse'],
  ] as const)('renders the %s verdict as %s', async (verdict, minSampleSizeMet, ci95, label) => {
    h.holdout = campaignHoldout({
      verdict,
      minSampleSizeMet,
      ci95,
      control: {
        entered: minSampleSizeMet ? 400 : 12,
        converted: 20,
        unsubscribed: 0,
        conversionRate: 0.05,
        unsubscribeRate: 0,
        revenue: { EUR: 2000 },
      },
    });

    render(<CampaignHoldoutCard campaignId={campaignId} artifact={campaignArtifact()} />);
    await screen.findByText('Campaign-wide holdout');
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('states an insufficient sample gate and an unavailable relative lift', async () => {
    h.holdout = campaignHoldout({
      verdict: 'not_enough_data',
      minSampleSizeMet: false,
      relativeLift: null,
      ci95: null,
      control: {
        entered: 12,
        converted: 0,
        unsubscribed: 0,
        conversionRate: 0,
        unsubscribeRate: 0,
        revenue: { EUR: 0 },
      },
    });

    render(<CampaignHoldoutCard campaignId={campaignId} artifact={campaignArtifact()} />);
    await screen.findAllByText('Insufficient sample');
    expect(screen.getByText(/Control 12 \/ minimum 200/)).toBeTruthy();
    expect(screen.getAllByText(/Relative lift unavailable/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Zero control conversion makes relative lift unavailable/)).toBeTruthy();
  });

  it('keeps journey controls separate from the campaign-wide holdout', async () => {
    renderTab();
    await screen.findByText('Campaign-wide holdout');
    await screen.findByText('Welcome series · Journey holdout');

    const journey = screen.getByRole('region', { name: 'Welcome series · Journey holdout' });
    const campaign = screen.getByRole('region', { name: 'Campaign-wide holdout' });
    expect(within(journey).queryByText(/Campaign-wide/)).toBeNull();
    expect(within(campaign).queryByText(/Journey holdout/)).toBeNull();
    expect(within(journey).getByText('Journey control; separate from the campaign-wide holdout.')).toBeTruthy();
    expect(
      within(campaign).getByText('Campaign-wide; includes every sending member. Separate from journey controls; no broadcast-only lift.'),
    ).toBeTruthy();
  });

  it('shows no assignments as unavailable, not a healthy zero result', async () => {
    h.holdout = campaignHoldout({
      verdict: 'not_enough_data',
      minSampleSizeMet: false,
      relativeLift: null,
      ci95: null,
      control: { entered: 0, converted: 0, unsubscribed: 0, conversionRate: 0, unsubscribeRate: 0, revenue: {} },
      treatment: { entered: 0, converted: 0, unsubscribed: 0, conversionRate: 0, unsubscribeRate: 0, revenue: {} },
    });

    render(<CampaignHoldoutCard campaignId={campaignId} artifact={campaignArtifact()} />);
    await screen.findByText('No assignments in this period');
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0);
  });

  it('does not render raw campaign or journey ids', async () => {
    renderTab();
    await screen.findByText('Campaign-wide holdout');
    expect(document.body.textContent).not.toContain(campaignId);
    expect(document.body.textContent).not.toContain(journeyId);
    expect(document.body.textContent).not.toContain(broadcastId);
  });
});

describe('campaign roll-up states (#511)', () => {
  it('shows a section skeleton and keeps the period control while loading', async () => {
    h.summary = () => new Promise(() => {});

    render(<CampaignEvaluation campaignId={campaignId} />);
    expect(screen.getByLabelText('Period')).toBeTruthy();
    expect(document.querySelector('section[aria-busy="true"]')).toBeTruthy();
    expect(screen.getAllByLabelText('Loading campaign evaluation').length).toBeGreaterThan(0);
  });

  it('names a not-started campaign and shows its actual readiness, never an all-zero chart', async () => {
    h.summary = notStarted();

    renderTab();
    await screen.findByText('No recorded campaign sends in this period');
    expect(screen.getByText('Campaign published')).toBeTruthy();
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.getByText('Sending members scheduled')).toBeTruthy();
    expect(screen.queryByText('Recipients')).toBeNull();
    expect(screen.queryByText('Campaign funnel')).toBeNull();
  });

  it('shows an observed zero as a returned zero with unavailable rates', async () => {
    h.summary = summaryMeasured({
      headline: {
        recipients: 0,
        delivered: 0,
        clickers: 0,
        unsubscribers: 0,
        complaintRate: null,
        unsubscribeRate: null,
        converters: 0,
        conversionRate: null,
        revenue: [],
        revenuePerRecipient: [],
        targetProgress: null,
      },
      funnel: [
        { step: 'recipients', count: 0, stepRate: null, shareOfRecipients: null },
        { step: 'delivered', count: 0, stepRate: null, shareOfRecipients: null },
        { step: 'clicked', count: 0, stepRate: null, shareOfRecipients: null },
        { step: 'converted', count: 0, stepRate: null, shareOfRecipients: null },
      ],
      members: [],
      holdouts: [],
    });

    renderTab();
    await screen.findByText('Zero recorded events');
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('No recorded campaign sends in this period')).toBeNull();
  });

  it('shows null and missing values as Unavailable, never as zero', async () => {
    h.summary = summaryMeasured({
      headline: {
        ...summaryMeasured().headline,
        complaintRate: null,
        unsubscribeRate: null,
        conversionRate: null,
        revenue: [],
        revenuePerRecipient: [],
        targetProgress: null,
      },
      members: [
        {
          ...summaryMeasured().members[0],
          delivered: 0,
          clickRate: null,
          unsubscribeRate: null,
        },
      ],
      holdouts: [],
    });

    renderTab();
    await screen.findByText('Progress unavailable');
    expect(screen.getByText('No attributed revenue')).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('withholds the headline and funnel when the server suppressed cells', async () => {
    h.summary = summaryMeasured({
      meta: { ...meta, suppressed: 2, k: 5, notes: ['Two groups were suppressed.'] },
    });

    renderTab();
    await screen.findByText('Values unavailable — fewer than 5 people');
    expect(screen.getByText(/k=5|k = 5/)).toBeTruthy();
    expect(screen.getByText('Two groups were suppressed.')).toBeTruthy();
    expect(screen.queryByText('Recipients')).toBeNull();
    expect(screen.queryByText('Campaign funnel')).toBeNull();
  });

  it('replaces old values while refreshing and keeps a failure local with Retry', async () => {
    h.summaryError = new Error('analytics unavailable');

    renderTab();
    await screen.findByText("Couldn't load the campaign evaluation");
    await screen.findByText('Campaign-wide holdout');
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);

    const before = summaryCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(summaryCalls().length).toBe(before + 1));
    expect(holdoutCalls()).toHaveLength(1);
  });

  it('keeps a holdout failure local and retries only the holdout read', async () => {
    h.holdoutError = new Error('holdout unavailable');

    renderTab();
    await screen.findAllByText('2,400');
    await screen.findByText("Couldn't load the campaign holdout");

    const before = holdoutCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(holdoutCalls().length).toBe(before + 1));
    expect(summaryCalls()).toHaveLength(1);
  });

  it('distinguishes a not-found campaign from an empty period', async () => {
    h.summaryError = new Error('This campaign does not exist.');

    render(<CampaignEvaluation campaignId={campaignId} />);
    await screen.findByText('Campaign not found');
    expect(screen.getByText(/not available at this address/)).toBeTruthy();
    expect(screen.queryByText('No recorded campaign sends in this period')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('ignores a stale response after a newer period is selected', async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    h.summary = (input: Record<string, unknown>) =>
      new Promise((resolve) => {
        resolvers.set(String(input.from), resolve);
      });

    render(<CampaignEvaluation campaignId={campaignId} />);
    await waitFor(() => expect(summaryCalls()).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30' } });
    await waitFor(() => expect(summaryCalls()).toHaveLength(2));

    resolvers.get('2026-10-07T00:00:00.000Z')!(summaryMeasured({ headline: { ...summaryMeasured().headline, recipients: 3000 } }));
    await screen.findAllByText('3,000');

    resolvers.get('2026-10-30T00:00:00.000Z')!(summaryMeasured({ headline: { ...summaryMeasured().headline, recipients: 9999 } }));
    await waitFor(() => expect(screen.queryByText('9,999')).toBeNull());
    expect(screen.getAllByText('3,000').length).toBeGreaterThan(0);
  });

  it('renders the period, denominators and event freshness', async () => {
    renderTab();
    await screen.findAllByText('2,400');

    expect(screen.getAllByText(/30 Oct–5 Nov 2026 · UTC · Latest event in period: 5 Nov 2026, 21:42/).length).toBeGreaterThan(0);
    expect(screen.getByText('144 / 2,400 recipients = 6%')).toBeTruthy();
    expect(screen.getByText('12 / 2,400 delivered people = 0.5%')).toBeTruthy();
  });

  it('labels a missing event timestamp as Unavailable and never as an epoch', async () => {
    h.summary = summaryMeasured({ meta: { ...meta, freshness: null } });

    renderTab();
    await screen.findAllByText('2,400');
    expect(screen.getAllByText(/Latest event in period: Unavailable/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/1970|Jan 1, 1970/);
  });
});

describe('campaign roll-up chart and table parity (#511)', () => {
  it('keeps the funnel bars and their table fallback on the same returned values', async () => {
    renderTab();
    await screen.findByRole('table', { name: 'Campaign funnel' });

    const recipients = screen.getByRole('img', { name: 'Recipients: 2,400 people' });
    const delivered = screen.getByRole('img', { name: 'Delivered: 2,400 people' });
    const clicked = screen.getByRole('img', { name: 'Clicked: 192 people' });
    const converted = screen.getByRole('img', { name: 'Converted: 144 people' });
    expect(recipients).toBeTruthy();
    expect(delivered).toBeTruthy();
    expect(clicked).toBeTruthy();
    expect(converted).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Campaign funnel' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('2,400')).toBeTruthy();
    expect(within(rows[2]!).getByText('2,400')).toBeTruthy();
    expect(within(rows[3]!).getByText('192')).toBeTruthy();
    expect(within(rows[4]!).getByText('144')).toBeTruthy();
  });

  it('does not clamp converters to clickers and labels the actual previous stage', async () => {
    h.summary = summaryMeasured({
      headline: { ...summaryMeasured().headline, clickers: 100, converters: 144, conversionRate: 0.06 },
      funnel: [
        { step: 'recipients', count: 2400, stepRate: null, shareOfRecipients: 1 },
        { step: 'delivered', count: 2400, stepRate: 1, shareOfRecipients: 1 },
        { step: 'clicked', count: 100, stepRate: 100 / 2400, shareOfRecipients: 100 / 2400 },
        { step: 'converted', count: 144, stepRate: 144 / 100, shareOfRecipients: 0.06 },
      ],
    });

    renderTab();
    await screen.findByRole('table', { name: 'Campaign funnel' });

    const clicked = screen.getByRole('img', { name: 'Clicked: 100 people' });
    const converted = screen.getByRole('img', { name: 'Converted: 144 people' });
    const clickedWidth = Number.parseFloat((clicked.firstElementChild as HTMLElement).style.width);
    const convertedWidth = Number.parseFloat((converted.firstElementChild as HTMLElement).style.width);
    expect(convertedWidth).toBeGreaterThan(clickedWidth);

    const table = screen.getByRole('table', { name: 'Campaign funnel' });
    expect(within(table).getByText('144% of Clicked')).toBeTruthy();
    expect(screen.getByText(/Step rate divides by the previous stage/)).toBeTruthy();
  });

  it('keeps member counts separate from the distinct recipients total', async () => {
    renderTab();
    await screen.findAllByText('2,400');

    expect(screen.getAllByText('1,600').length).toBeGreaterThan(0);
    expect(screen.getAllByText('900').length).toBeGreaterThan(0);
    expect(screen.queryByText('2,500')).toBeNull();
    expect(screen.getByText('People can receive several members. Member counts do not sum to distinct campaign recipients.')).toBeTruthy();
  });
});
