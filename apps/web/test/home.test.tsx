import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #447 Home: role order, bounded reads, per-block states, KPI data states and the derived
// checklist. Every test mocks the typed API and the session, so the assertions can count the
// exact reads Home issues.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown }[],
  handler: null as null | ((name: string, input: any) => any),
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: (name: string, input: unknown) => {
        h.calls.push({ name, input });
        if (!h.handler) return Promise.reject(new Error('No Home test handler'));
        return Promise.resolve(h.handler(name, input));
      },
    },
  };
});

const session = vi.hoisted(() => ({ current: null as any }));
vi.mock('../src/app/session', () => ({ useWorkspace: () => session.current }));

const HomePage = (await import('../src/pages/HomePage')).default;
const { homePeriod } = await import('../src/features/home/period');
const PERIOD = homePeriod(new Date(), 'UTC');

const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: [
    'artifacts:read',
    'artifacts:write',
    'artifacts:publish',
    'artifacts:approve',
    'messages:send',
    'audit:read',
    'profiles:read',
    'profiles:pii',
    'profiles:write',
    'secrets:read',
    'secrets:write',
    'workspace:admin',
  ],
  admin: [
    'artifacts:read',
    'artifacts:write',
    'artifacts:publish',
    'artifacts:approve',
    'messages:send',
    'audit:read',
    'profiles:read',
    'profiles:pii',
    'profiles:write',
    'secrets:read',
    'secrets:write',
    'workspace:admin',
  ],
  marketer: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'messages:send', 'audit:read', 'profiles:read', 'profiles:write'],
  approver: ['artifacts:read', 'artifacts:approve', 'audit:read', 'profiles:read'],
  viewer: ['artifacts:read'],
  restricted: [],
};

const BASE_WORKSPACE = {
  id: 'ws1',
  name: 'MartechSignal',
  approvalPolicy: 'agent_changes',
  timeZone: 'UTC',
  seedList: [],
  domains: [],
  linksUrl: 'https://links.martechsignal.com',
  brand: { siteName: 'MartechSignal', logoUrl: null, primaryDomain: null },
  serverVersion: '0.10.0',
  permissionsExplained: [],
};

function install(role: string, options: { permissions?: string[]; domains?: unknown[]; name?: string } = {}) {
  const permissions = options.permissions ?? ROLE_PERMISSIONS[role] ?? ['artifacts:read'];
  session.current = {
    user: { id: 'u1', name: 'Alex', email: 'alex@example.com' },
    workspace: {
      ...BASE_WORKSPACE,
      name: options.name ?? BASE_WORKSPACE.name,
      domains: options.domains ?? [],
      you: { type: 'user', userId: 'u1', role, permissions },
    },
    can: (permission: string) => permissions.includes(permission),
  };
}

const verifiedPrimaryDomain = {
  id: 'dom1',
  host: 'links.martechsignal.com',
  pathPrefix: null,
  isPrimary: true,
  status: 'verified',
  verificationToken: 'token',
  verifiedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  url: 'https://links.martechsignal.com',
};

const emptyApprovals = () => ({ approvals: [], total: 0, nextCursor: null });
const emptyAgents = () => ({ agents: [] });
const emptyAlerts = () => ({ rules: [] });
const emptyFailures = () => ({ runs: [], nextCursor: null, asOf: '2026-11-06T10:00:00.000Z' });
const emptyBroadcasts = () => ({ broadcasts: [], total: 0, nextCursor: null, asOf: '2026-11-06T10:00:00.000Z' });
const emptyArtifacts = () => ({ artifacts: [], total: 0, nextCursor: null });
const emptyProfiles = () => ({ profiles: [], nextCursor: null });
const emptyStatus = () => ({
  serverVersion: '0.10.0',
  emailProvider: { configured: false, marketing: false, transactional: false, adapter: null, tracking: null },
  pendingApprovals: 0,
});
const configuredStatus = () => ({
  ...emptyStatus(),
  emailProvider: { ...emptyStatus().emailProvider, configured: true, marketing: true, transactional: true, adapter: 'ses' },
});

const analytics = (rows: (number | null)[][], suppressed = 0, freshness: string | null = '2026-11-05T23:48:00.000Z') => ({
  columns: [
    { name: 'email.sent', kind: 'measure', unit: 'count' },
    { name: 'email.delivered', kind: 'measure', unit: 'count' },
    { name: 'email.clicked', kind: 'measure', unit: 'count' },
    { name: 'email.click_rate', kind: 'measure', unit: 'ratio' },
  ],
  rows,
  meta: {
    timeZone: 'UTC',
    currency: null,
    from: '2026-10-30T00:00:00.000Z',
    to: '2026-11-06T00:00:00.000Z',
    freshness,
    suppressed,
    k: 5,
    notes: [],
  },
});

const zeroAnalytics = () => analytics([[0, 0, 0, null]]);
const populatedAnalytics = () => analytics([[18240, 17982, 1126, 1126 / 17982]]);
const previousAnalytics = () => analytics([[16850, 16620, 1010, 1010 / 16620]]);

function defaultResponse(name: string, _input: any) {
  switch (name) {
    case 'approvals.list':
      return emptyApprovals();
    case 'agents.list':
      return emptyAgents();
    case 'alerts.list':
      return emptyAlerts();
    case 'agents.runFailures':
      return emptyFailures();
    case 'broadcasts.list':
      return emptyBroadcasts();
    case 'artifacts.list':
      return emptyArtifacts();
    case 'profiles.list':
      return emptyProfiles();
    case 'system.status':
      return emptyStatus();
    case 'analytics.query':
      // The previous-period query is the second call in one Home load; tests that care override it.
      return zeroAnalytics();
    default:
      throw new Error(`Unexpected Home command ${name}`);
  }
}

function renderHome(role: string, handler?: (name: string, input: any) => any, options?: Parameters<typeof install>[1]) {
  install(role, options);
  h.handler = handler ?? defaultResponse;
  return render(<HomePage />);
}

const headings = () => screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

const names = () => h.calls.map((call) => call.name);
const callsOf = (name: string) => h.calls.filter((call) => call.name === name);

const loaded = () => screen.findByText(/^Fetched /);

const brandPublished = (version = 1, name = 'MartechSignal') => ({
  artifacts: [
    {
      id: 'brd_1',
      type: 'brand',
      name,
      latestVersion: version,
      latestState: 'published',
      publishedVersion: version,
      updatedAt: '2026-11-04T10:00:00.000Z',
    },
  ],
  total: 1,
  nextCursor: null,
});

const brandDraft = () => ({
  artifacts: [
    {
      id: 'brd_1',
      type: 'brand',
      name: 'MartechSignal',
      latestVersion: 1,
      latestState: 'draft',
      publishedVersion: null,
      updatedAt: '2026-11-04T10:00:00.000Z',
    },
  ],
  total: 1,
  nextCursor: null,
});

const approval = (overrides: Record<string, unknown> = {}) => ({
  id: 'apr_1',
  artifactId: 'bct_1',
  artifactName: 'November lifecycle briefing',
  artifactType: 'broadcast',
  version: 3,
  status: 'pending',
  requestedBy: { type: 'agent', id: 'agt_1', client: 'token:tok_1' },
  requester: {
    kind: 'oauth_client',
    displayName: 'Newsletter agent',
    personName: 'Alex',
    tokenName: null,
    tokenId: null,
    clientName: 'Newsletter agent',
  },
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 3,
  artifactPublishedVersion: 2,
  reviewUrl: 'https://am.example/approvals/apr_1',
  bundle: null,
  ...overrides,
});

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: 'agt_1',
  name: 'Newsletter research agent',
  description: '',
  sponsor: { id: 'u1', name: 'Alex' },
  status: 'active',
  statusReason: null,
  statusChangedAt: null,
  brand: null,
  credentials: [],
  guard: null,
  last24h: { changes: 0, denied: 0, escalated: 0, held: 0 },
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const alertRule = (overrides: Record<string, unknown> = {}) => ({
  id: 'alr_1',
  name: 'Marketing bounce rate',
  kind: 'deliverability',
  config: {},
  channels: [],
  enabled: true,
  createdBy: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-06T08:00:00.000Z',
  state: 'firing',
  firingSince: '2026-11-06T08:10:00.000Z',
  ...overrides,
});

const failedRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'hrn_1',
  agentId: 'agt_1',
  agentName: 'Newsletter research agent',
  startedAt: '2026-11-06T09:12:00.000Z',
  finishedAt: '2026-11-06T09:13:00.000Z',
  status: 'failed',
  summary: 'Summarised the week’s articles',
  error: 'Provider timed out',
  ...overrides,
});

const broadcastRun = (overrides: Record<string, unknown> = {}) => ({
  status: 'scheduled',
  version: 3,
  sendAt: '2026-11-06T14:00:00.000Z',
  recipients: 0,
  queued: 0,
  skipped: 0,
  windowSkipped: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  ...overrides,
});

const broadcast = (overrides: Record<string, unknown> = {}) => ({
  artifactId: 'bct_1',
  name: 'Signal Weekly · issue 128',
  latestVersion: 3,
  latestState: 'published',
  publishedVersion: 3,
  updatedAt: '2026-11-06T09:00:00.000Z',
  run: broadcastRun(),
  segmentId: 'seg_1',
  templateId: 'eml_1',
  stage: null,
  delivery: {},
  ...overrides,
});

const journey = (overrides: Record<string, unknown> = {}) => ({
  id: 'jrn_1',
  type: 'journey',
  name: 'Welcome to MartechSignal',
  latestVersion: 4,
  latestState: 'published',
  publishedVersion: 4,
  updatedAt: '2026-11-05T10:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  h.calls.length = 0;
  h.handler = defaultResponse;
  localStorage.clear();
});

afterEach(() => cleanup());

describe('Home role order (#447)', () => {
  it.each([
    ['owner', ['Set up MartechSignal', 'Needs attention', 'Running', 'E-mail performance']],
    ['admin', ['Set up MartechSignal', 'Needs attention', 'Running', 'E-mail performance']],
    ['marketer', ['Set up MartechSignal', 'Running', 'Needs attention', 'E-mail performance']],
    ['approver', ['Needs attention', 'Running', 'E-mail performance']],
    ['viewer', ['E-mail performance', 'Running', 'Needs attention']],
  ])('orders the sections for %s', async (role, expected) => {
    renderHome(role);
    expect(headings()).toEqual(expected);
    await loaded();
  });

  it('uses viewer order for an unknown role, without adding a new role name', async () => {
    renderHome('custom', undefined, { permissions: ['artifacts:read'] });
    expect(headings()).toEqual(['E-mail performance', 'Running', 'Needs attention']);
    await loaded();
  });
});

describe('Home reads (#447)', () => {
  it('owner populated: every block uses one bounded read, with no per-row fan-out', async () => {
    renderHome(
      'owner',
      (name, input) => {
        if (name === 'artifacts.list' && input.type === 'brand') return brandPublished(2);
        if (name === 'artifacts.list' && input.type === 'journey') return { artifacts: [journey()], total: 1, nextCursor: null };
        if (name === 'approvals.list')
          return {
            approvals: [
              approval(),
              approval({ id: 'apr_2', artifactName: 'Reactivation canary', version: 2, holdUntil: '2026-11-06T16:00:00.000Z' }),
            ],
            total: 4,
            nextCursor: null,
          };
        if (name === 'agents.list')
          return {
            agents: [
              agent(),
              agent({
                id: 'agt_2',
                name: 'Guardrail agent',
                guard: { cap: 0, reason: 'Guardian capped it', since: '2026-11-05T08:00:00.000Z', episodeIds: [] },
              }),
            ],
          };
        if (name === 'alerts.list') return { rules: [alertRule()] };
        if (name === 'agents.runFailures') return { runs: [failedRun()], nextCursor: 'next', asOf: '2026-11-06T10:00:00.000Z' };
        if (name === 'broadcasts.list')
          return {
            broadcasts: [
              broadcast(),
              broadcast({
                artifactId: 'bct_2',
                name: 'November product notes',
                run: broadcastRun({ status: 'running', sendAt: null, startedAt: '2026-11-06T10:02:00.000Z' }),
              }),
            ],
            total: 2,
            nextCursor: null,
            asOf: '2026-11-06T10:00:00.000Z',
          };
        if (name === 'profiles.list') return { profiles: [{ id: 'prs_1' }], nextCursor: null };
        if (name === 'system.status') return configuredStatus();
        if (name === 'analytics.query') return input.from === PERIOD.from ? populatedAnalytics() : previousAnalytics();
        return defaultResponse(name, input);
      },
      { domains: [verifiedPrimaryDomain] },
    );
    await loaded();

    expect(screen.getByText('November lifecycle briefing')).toBeTruthy();
    expect(screen.getByText('Reactivation canary')).toBeTruthy();
    expect(screen.getByText('Marketing bounce rate')).toBeTruthy();
    expect(screen.getAllByText('Newsletter research agent').length).toBeGreaterThan(0);
    expect(screen.getByText('Signal Weekly · issue 128')).toBeTruthy();
    expect(screen.getByText('Welcome to MartechSignal')).toBeTruthy();
    expect(screen.getByText('18,240')).toBeTruthy();
    // All four checks are confirmed on a successful read, so the checklist is hidden but restorable.
    expect(screen.queryByRole('heading', { name: 'Set up MartechSignal' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show setup checklist' })).toBeTruthy();

    expect(callsOf('approvals.list')).toHaveLength(1);
    expect(callsOf('agents.list')).toHaveLength(1);
    expect(callsOf('alerts.list')).toHaveLength(1);
    expect(callsOf('agents.runFailures')).toHaveLength(1);
    expect(callsOf('broadcasts.list')).toHaveLength(1);
    expect(callsOf('analytics.query')).toHaveLength(2);
    expect(callsOf('artifacts.list')).toHaveLength(2);
    expect(callsOf('profiles.list')).toHaveLength(1);
    expect(callsOf('system.status')).toHaveLength(1);
    expect(callsOf('approvals.list')[0].input).toEqual({ status: 'pending', limit: 20 });
    expect(callsOf('broadcasts.list')[0].input).toEqual({ statuses: ['scheduled', 'running'], limit: 5 });
    expect(callsOf('analytics.query').at(-1)?.input).toMatchObject({ dimensions: [], limit: 1 });
    for (const forbidden of [
      'broadcasts.status',
      'agents.report',
      'agents.runs',
      'journeys.stats',
      'approvals.get',
      'analytics.metrics.list',
    ])
      expect(names()).not.toContain(forbidden);
  });

  it('viewer: no checklist or admin reads, and performance still comes first', async () => {
    renderHome('viewer');
    expect(headings()).toEqual(['E-mail performance', 'Running', 'Needs attention']);
    await loaded();
    expect(names().sort()).toEqual(
      [
        'agents.list',
        'agents.runFailures',
        'alerts.list',
        'analytics.query',
        'analytics.query',
        'approvals.list',
        'artifacts.list',
        'broadcasts.list',
      ].sort(),
    );
    expect(callsOf('artifacts.list')).toHaveLength(1);
    expect(callsOf('artifacts.list')[0].input).toEqual({ type: 'journey', limit: 20 });
    expect(names()).not.toContain('system.status');
    expect(names()).not.toContain('profiles.list');
  });

  it('marketer: reads the configuration with its real permissions and sees a complete setup confirmed', async () => {
    renderHome(
      'marketer',
      (name, input) => {
        if (name === 'artifacts.list' && input.type === 'brand') return brandPublished(1);
        if (name === 'profiles.list') return { profiles: [{ id: 'prs_1' }], nextCursor: null };
        if (name === 'system.status') return configuredStatus();
        return defaultResponse(name, input);
      },
      { domains: [verifiedPrimaryDomain] },
    );
    await loaded();
    expect(screen.queryByRole('heading', { name: 'Set up MartechSignal' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show setup checklist' }));
    expect(screen.getByText('4 of 4 confirmed · based on current configuration')).toBeTruthy();
    expect(callsOf('system.status')).toHaveLength(1);
    expect(callsOf('artifacts.list').some((call) => (call.input as { type?: string }).type === 'brand')).toBe(true);
    expect(callsOf('profiles.list')).toHaveLength(1);
  });

  it('a role without artifacts:read issues no operational reads and sees the restricted copy', async () => {
    renderHome('restricted', undefined, { permissions: [] });
    expect(screen.getByText('Your role cannot view operational work')).toBeTruthy();
    expect(screen.getByText('Your role cannot view e-mail performance')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.calls).toHaveLength(0);
  });
});

describe('Home block states (#447)', () => {
  it('a new brand shows honest empty Running and performance states', async () => {
    renderHome('owner', (name, input) => {
      if (name === 'artifacts.list') return emptyArtifacts();
      if (name === 'profiles.list') return emptyProfiles();
      if (name === 'analytics.query') return zeroAnalytics();
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getByRole('heading', { name: 'Set up MartechSignal' })).toBeTruthy();
    expect(screen.getByText('0 of 4 confirmed · based on current configuration')).toBeTruthy();
    expect(screen.getAllByText('No pending requests')).toHaveLength(2);
    expect(screen.getByText('No firing alerts')).toBeTruthy();
    expect(screen.getByText('No guardian caps')).toBeTruthy();
    expect(screen.getByText('No failed hosted runs in the last 7 days')).toBeTruthy();
    expect(screen.getByText('No scheduled or sending broadcasts')).toBeTruthy();
    expect(screen.getByText('No live journeys')).toBeTruthy();
    expect(screen.getByText('No active agents')).toBeTruthy();
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('No sends in this period').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('one failed block keeps the others and offers Retry', async () => {
    let failures = true;
    renderHome('owner', (name, input) => {
      if (name === 'agents.runFailures') {
        if (failures) throw new Error('Hosted-run history is unavailable.');
        return { runs: [failedRun()], nextCursor: null, asOf: '2026-11-06T10:00:00.000Z' };
      }
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getByText("Couldn't load recent failed hosted runs")).toBeTruthy();
    expect(screen.getByText('Hosted-run history is unavailable.')).toBeTruthy();
    expect(screen.getByText('No firing alerts')).toBeTruthy();
    failures = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Provider timed out')).toBeTruthy());
  });

  it('shows a named skeleton for every block while loading', async () => {
    const resolvers: (() => void)[] = [];
    renderHome('owner', (name, input) => {
      return new Promise((resolve) => {
        resolvers.push(() => resolve(defaultResponse(name, input)));
      });
    });
    expect(screen.getByLabelText('Loading pending reviews')).toBeTruthy();
    expect(screen.getByLabelText('Loading held requests')).toBeTruthy();
    expect(screen.getByLabelText('Loading firing alerts')).toBeTruthy();
    expect(screen.getByLabelText('Loading guardian caps')).toBeTruthy();
    expect(screen.getByLabelText('Loading recent failed hosted runs')).toBeTruthy();
    expect(screen.getByLabelText('Loading scheduled and sending broadcasts')).toBeTruthy();
    expect(screen.getByLabelText('Loading live journeys')).toBeTruthy();
    expect(screen.getByLabelText('Loading active agents')).toBeTruthy();
    expect(screen.getByLabelText('E-mails sent').getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByText('Checking…').length).toBe(3);
    await act(async () => {
      for (const resolve of resolvers) resolve();
      await Promise.resolve();
    });
    await loaded();
  });

  it('a failed refresh keeps the last values and says so', async () => {
    let fail = false;
    renderHome('owner', (name, input) => {
      if (fail) throw new Error('Offline');
      if (name === 'analytics.query') return input.from === PERIOD.from ? populatedAnalytics() : previousAnalytics();
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getByText('18,240')).toBeTruthy();
    fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText(/Last loaded .*; refresh failed/)).toBeTruthy());
    expect(screen.getByText('18,240')).toBeTruthy();
  });
});

describe('Home KPI data states (#447)', () => {
  it('shows the four values, relative count deltas and the rate in percentage points', async () => {
    renderHome('viewer', (name, input) => {
      if (name === 'analytics.query') return input.from === PERIOD.from ? populatedAnalytics() : previousAnalytics();
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getByText('E-mails sent')).toBeTruthy();
    expect(screen.getByText('Delivered')).toBeTruthy();
    expect(screen.getByText('Clicked')).toBeTruthy();
    expect(screen.getByText('Click rate')).toBeTruthy();
    expect(screen.getByText('18,240')).toBeTruthy();
    expect(screen.getByText('6.3')).toBeTruthy();
    expect(screen.getAllByText('↑ 8.2% more').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('↑ 0.2 pp higher')).toBeTruthy();
    expect(screen.getByText('1,126 / 17,982')).toBeTruthy();
  });

  it('sent = 0 is an observation, not a healthy zero; the rate is an em dash without a denominator', async () => {
    renderHome('viewer', (name, input) => {
      if (name === 'analytics.query') return zeroAnalytics();
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getAllByText('0')).toHaveLength(3);
    expect(screen.getAllByText('No sends in this period').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('1,126 / 17,982')).toBeNull();
  });

  it('suppressed nulls say so and never leak a count', async () => {
    renderHome('viewer', (name, input) => {
      if (name === 'analytics.query') return analytics([[18240, 17982, null, null]], 5);
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getAllByText('Suppressed · fewer than 5 people')).toHaveLength(2);
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('a missing non-suppressed measure is unavailable, never zero', async () => {
    renderHome('viewer', (name, input) => {
      if (name === 'analytics.query') return analytics([[18240, 17982, null, null]], 0);
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getAllByText('Unavailable in this period')).toHaveLength(2);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('a failed previous period removes only the delta', async () => {
    renderHome('viewer', (name, input) => {
      if (name === 'analytics.query') {
        if (input.from === PERIOD.from) return populatedAnalytics();
        throw new Error('Comparison unavailable');
      }
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getByText('18,240')).toBeTruthy();
    expect(screen.queryByText(/↑ .* more/)).toBeNull();
    expect(screen.getAllByText('No comparable baseline').length).toBe(4);
  });

  it('a failed performance query says unavailable and retries', async () => {
    let fail = true;
    renderHome('viewer', (name, input) => {
      if (name === 'analytics.query') {
        if (fail) throw new Error('Metrics are down');
        return input.from === PERIOD.from ? populatedAnalytics() : previousAnalytics();
      }
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getByText('Performance unavailable')).toBeTruthy();
    expect(screen.getByText('Metrics are down')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('18,240')).toBeTruthy());
  });
});

describe('Home approvals and attention (#447)', () => {
  it('uses the total for the header and labels approve links by permission', async () => {
    const approvals = {
      approvals: [approval(), approval({ id: 'apr_2', artifactName: 'Held request', holdUntil: '2020-01-01T00:00:00.000Z' })],
      total: 12,
      nextCursor: 'next',
    };
    renderHome('approver', (name, input) => (name === 'approvals.list' ? approvals : defaultResponse(name, input)));
    await loaded();
    expect(screen.getByText('12 pending requests · oldest 20 loaded')).toBeTruthy();
    expect(screen.getAllByText('Review')).toHaveLength(2);
    expect(screen.getByText(/Window passed; awaiting recheck/)).toBeTruthy();
    cleanup();

    renderHome('viewer', (name, input) => (name === 'approvals.list' ? approvals : defaultResponse(name, input)));
    await loaded();
    expect(screen.getAllByText('View request')).toHaveLength(2);
  });

  it('does not claim a partition is globally empty when only the oldest page is loaded', async () => {
    renderHome('viewer', (name, input) =>
      name === 'approvals.list' ? { approvals: [approval()], total: 21, nextCursor: 'next' } : defaultResponse(name, input),
    );
    await loaded();
    expect(screen.getByText('No holds in the oldest 20 loaded requests')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View Approvals' })).toBeTruthy();
  });

  it('groups bundle members and marks a partially loaded bundle', async () => {
    const bundled = approval({
      bundle: {
        id: 'bnd_1',
        members: [
          { approvalId: 'apr_1', artifactId: 'bct_1', artifactName: 'November lifecycle briefing', artifactType: 'broadcast', version: 3 },
          { approvalId: 'apr_9', artifactId: 'eml_1', artifactName: 'Weekly Signal template', artifactType: 'email_template', version: 2 },
        ],
      },
    });
    renderHome('owner', (name, input) =>
      name === 'approvals.list' ? { approvals: [bundled], total: 2, nextCursor: 'next' } : defaultResponse(name, input),
    );
    await loaded();
    expect(screen.getByText('2 changes in one bundle · More members in Approvals')).toBeTruthy();
  });
});

describe('Home checklist (#447)', () => {
  const confirmedHandler = (name: string, input: any) => {
    if (name === 'artifacts.list' && input.type === 'brand') return brandPublished(1);
    if (name === 'profiles.list') return { profiles: [{ id: 'prs_1' }], nextCursor: null };
    if (name === 'system.status') return configuredStatus();
    return defaultResponse(name, input);
  };

  it('hides when all four are confirmed, and the footer opens the read-only confirmed view', async () => {
    renderHome('owner', confirmedHandler, { domains: [verifiedPrimaryDomain] });
    await loaded();
    expect(screen.queryByRole('heading', { name: 'Set up MartechSignal' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show setup checklist' }));
    expect(screen.getByText('4 of 4 confirmed · based on current configuration')).toBeTruthy();
    expect(screen.getByText('Setup confirmed')).toBeTruthy();
    expect(screen.getAllByText(/Confirmed from current configuration/)).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Set up MartechSignal' })).toBeNull();
  });

  it('detects a published brand through pagination and stops immediately', async () => {
    let brandCalls = 0;
    renderHome(
      'owner',
      (name, input) => {
        if (name === 'artifacts.list' && input.type === 'brand') {
          brandCalls++;
          if (brandCalls === 1)
            return {
              artifacts: [{ ...brandDraft().artifacts[0], id: 'brd_draft', name: 'Old draft' }],
              total: 2,
              nextCursor: 'cursor-1',
            };
          return brandPublished(1);
        }
        if (name === 'profiles.list') return { profiles: [{ id: 'prs_1' }], nextCursor: null };
        if (name === 'system.status') return configuredStatus();
        return defaultResponse(name, input);
      },
      { domains: [verifiedPrimaryDomain] },
    );
    await loaded();
    expect(brandCalls).toBe(2);
    const brandReads = callsOf('artifacts.list').filter((call) => (call.input as { type?: string }).type === 'brand');
    expect(brandReads).toHaveLength(2);
    expect((brandReads[1].input as { cursor?: string }).cursor).toBe('cursor-1');
    // The published pointer on the second page confirms the item, so the completed checklist hides.
    expect(screen.queryByRole('heading', { name: 'Set up MartechSignal' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show setup checklist' }));
    expect(screen.getByText('4 of 4 confirmed · based on current configuration')).toBeTruthy();
    cleanup();

    brandCalls = 0;
    renderHome('owner', (name, input) => {
      if (name === 'artifacts.list' && input.type === 'brand') {
        brandCalls++;
        return { ...brandPublished(1), nextCursor: 'more' };
      }
      return confirmedHandler(name, input);
    });
    await loaded();
    expect(brandCalls).toBe(1);
  });

  it('a draft brand alone is incomplete', async () => {
    renderHome(
      'owner',
      (name, input) => {
        if (name === 'artifacts.list' && input.type === 'brand') return brandDraft();
        if (name === 'profiles.list') return { profiles: [{ id: 'prs_1' }], nextCursor: null };
        if (name === 'system.status') return configuredStatus();
        return defaultResponse(name, input);
      },
      { domains: [verifiedPrimaryDomain] },
    );
    await loaded();
    expect(screen.getByText('3 of 4 confirmed · based on current configuration')).toBeTruthy();
    const row = screen.getByRole('link', { name: 'Publish your brand' });
    expect(row.getAttribute('href')).toBe('/content/brand');
  });

  it('does not mark a restricted check confirmed and keeps the denominator at four', async () => {
    renderHome('marketer', undefined, { permissions: [] });
    await loaded();
    expect(screen.getByText('0 of 4 confirmed · based on current configuration')).toBeTruthy();
    expect(screen.getAllByText('Ask an admin')).toHaveLength(4);
  });

  it('hides on request, survives a remount for this user and workspace, and the footer restores it', async () => {
    renderHome('owner', (name, input) => {
      if (name === 'artifacts.list' && input.type === 'brand') return brandDraft();
      if (name === 'profiles.list') return { profiles: [], nextCursor: null };
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.getByRole('heading', { name: 'Set up MartechSignal' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Hide setup checklist' }));
    const key = 'am.homeChecklist.u1.ws1.v1';
    expect(localStorage.getItem(key)).toBe('hidden');
    expect(screen.queryByRole('heading', { name: 'Set up MartechSignal' })).toBeNull();

    cleanup();
    h.calls.length = 0;
    renderHome('owner', (name, input) => {
      if (name === 'artifacts.list') return brandDraft();
      if (name === 'profiles.list') return emptyProfiles();
      return defaultResponse(name, input);
    });
    await loaded();
    expect(screen.queryByRole('heading', { name: 'Set up MartechSignal' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show setup checklist' }));
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Set up MartechSignal' })).toBeTruthy();
  });

  it('a failed check says so and Retry re-reads it', async () => {
    let failProfiles = true;
    renderHome(
      'owner',
      (name, input) => {
        if (name === 'profiles.list') {
          if (failProfiles) throw new Error('People are unavailable');
          return { profiles: [{ id: 'prs_1' }], nextCursor: null };
        }
        if (name === 'artifacts.list' && input.type === 'brand') return brandDraft();
        if (name === 'system.status') return configuredStatus();
        return defaultResponse(name, input);
      },
      { domains: [verifiedPrimaryDomain] },
    );
    await loaded();
    expect(screen.getByText('People are unavailable')).toBeTruthy();
    expect(screen.getByText("Couldn't check")).toBeTruthy();
    failProfiles = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('3 of 4 confirmed · based on current configuration')).toBeTruthy());
  });
});
