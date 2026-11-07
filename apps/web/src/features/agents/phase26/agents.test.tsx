import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../app/api';
import AgentPage from '../../../pages/settings/AgentPage';
import AgentsPage from '../../../pages/settings/AgentsPage';
import { setWorkspaceTimeZone } from '../../../ui/time';
import { ToastProvider } from '../../../ui/toast';

type Call = { name: string; input: any };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  can: (_permission: string): boolean => true,
  respond: (_name: string, _input: any): unknown => {
    throw new Error('no mock response');
  },
  pauseError: null as Error | null,
  agentError: null as Error | null,
  reportError: null as Error | null,
  listError: null as Error | null,
  compareError: null as Error | null,
  mandateError: null as Error | null,
  hostedError: null as Error | null,
  hold: new Set<string>(),
  held: [] as { name: string; input: any; resolve: (value: unknown) => void }[],
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: any) => {
        h.calls.push({ name, input });
        if (h.hold.has(name)) {
          return new Promise((resolve) => h.held.push({ name, input, resolve }));
        }
        if (name === 'agents.pause' && h.pauseError) throw h.pauseError;
        if (name === 'agents.get' && h.agentError) throw h.agentError;
        if (name === 'agents.report' && h.reportError) throw h.reportError;
        if (name === 'agents.list' && h.listError) throw h.listError;
        if (name === 'agents.compare' && h.compareError) throw h.compareError;
        if (name === 'agents.mandate' && h.mandateError) throw h.mandateError;
        if (name === 'agents.hostedRuns' && h.hostedError) throw h.hostedError;
        return h.respond(name, input);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useWorkspace: () => ({
    can: (permission: string) => h.can(permission),
    workspace: { id: 'ws_1', timeZone: 'UTC' },
    user: { id: 'u1' },
  }),
  useSession: () => ({
    can: (permission: string) => h.can(permission),
    workspace: { id: 'ws_1', timeZone: 'UTC' },
    user: { id: 'u1' },
  }),
}));

const agentId = `agt_${'a'.repeat(32)}`;
const otherAgentId = `agt_${'b'.repeat(32)}`;
const mandateId = `mnd_${'c'.repeat(32)}`;
const journeyId = `jrn_${'d'.repeat(32)}`;
const broadcastId = `bct_${'e'.repeat(32)}`;
const userId = `user_${'f'.repeat(32)}`;

const from = '2026-10-30T00:00:00.000Z';
const to = '2026-11-05T23:59:59.999Z';

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: agentId,
  name: 'Newsletter assistant',
  description: 'Sends the weekly newsletter.',
  sponsor: { id: userId, name: 'Sam Rivera' },
  status: 'active',
  statusReason: null,
  statusChangedAt: null,
  brand: null,
  credentials: [
    { kind: 'api_token', id: `tok_${'1'.repeat(32)}`, since: '2026-10-01T09:00:00.000Z' },
    { kind: 'hosted', id: `hst_${'2'.repeat(32)}`, since: '2026-10-02T09:00:00.000Z' },
  ],
  guard: null,
  last24h: { changes: 3, denied: 0, escalated: 1, held: 0 },
  createdAt: '2026-09-01T09:00:00.000Z',
  ...overrides,
});

const otherAgent = () =>
  agent({
    id: otherAgentId,
    name: 'Lifecycle assistant',
    description: 'Runs welcome journeys.',
    status: 'active',
    credentials: [{ kind: 'oauth_client', id: `mcp_${'3'.repeat(32)}`, since: '2026-10-03T09:00:00.000Z' }],
    last24h: { changes: 1, denied: 0, escalated: 0, held: 0 },
  });

const outcomes = () => ({
  broadcasts: {
    count: 2,
    sent: 2400,
    opened: 800,
    clicked: 192,
    unsubscribed: 12,
    complained: 1,
    bounced: 20,
  },
  direct: {
    count: 1,
    sent: 40,
    opened: 20,
    clicked: 5,
    unsubscribed: 0,
    complained: 0,
    bounced: 0,
  },
  journeys: [{ id: journeyId, verdict: 'no_clear_difference', note: 'The interval includes zero; no clear difference.' }],
  goals: [
    { measure: 'email.click_rate', target: 0.035, direction: 'up', value: 0.08, met: true, note: null },
    { measure: 'email.unsubscribe_rate', target: 0.004, direction: 'down', value: null, met: null, note: 'Not measured yet.' },
  ],
});

const report = (overrides: Record<string, unknown> = {}) => ({
  agentId,
  from,
  to,
  actions: {
    'content.publish': { allow: 4, hold: 1, ask: 0, deny: 1, failed: 0 },
    'send.broadcast': { allow: 2, hold: 0, ask: 1, deny: 0, failed: 1 },
  },
  undone: 0,
  guardian: {},
  ownedArtifacts: [],
  heldConflicts: [],
  contactPressureSkipped: 0,
  outcomes: outcomes(),
  ...overrides,
});

const mandateContent = (overrides: Record<string, unknown> = {}) => ({
  agent: agentId,
  purpose: 'Send the weekly newsletter and its follow-ups.',
  goals: [
    { measure: 'email.click_rate', target: 0.035, direction: 'up' },
    { measure: 'email.unsubscribe_rate', target: 0.004, direction: 'down' },
  ],
  scope: {
    segments: [`seg_${'4'.repeat(32)}`],
    purposes: ['marketing_email'],
    topics: ['newsletter'],
    channels: ['email'],
    artifactTypes: ['broadcast', 'email_template'],
    artifacts: [],
    brand: null,
  },
  levels: {
    draft: 3,
    'content.publish': 2,
    'send.broadcast': 3,
    'send.direct': 2,
    'data.write': 1,
  },
  limits: { recipientsPerSend: 5000, recipientGrowth: 1.2, sendsPerDay: 1, changesPerDay: 20, messagesPerDay: 5000 },
  guardrails: { unsubscribeRate: 0.005, complaintRate: 0.001, bounceRate: 0.03, window: 'P7D', minSent: 200 },
  validUntil: '2027-02-01T00:00:00.000Z',
  workingHours: { start: '07:00', end: '11:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
  blackoutDates: ['2026-12-24', '2026-12-25'],
  holdWindow: 'PT2H',
  escalation: { userIds: [userId] },
  independentCheck: false,
  learning: { broadcastHoldout: true },
  shadow: false,
  ...overrides,
});

const mandateResponse = (overrides: Record<string, unknown> = {}) => ({
  agentId,
  mandate: { id: mandateId, version: 4, content: mandateContent() },
  outsideHours: null,
  asOf: '2026-11-07T08:30:00.000Z',
  ...overrides,
});

const autonomy = (overrides: Record<string, unknown> = {}) => ({
  switch: 'on',
  maxLevel: {
    draft: 3,
    'content.publish': 2,
    'audience.publish': 2,
    'send.broadcast': 2,
    'send.direct': 2,
    'journey.live': 2,
    'experience.live': 2,
    spend: 1,
    'data.write': 2,
    settings: 1,
    destructive: 1,
  },
  allowLoops: false,
  audienceThreshold: 1000,
  limits: { changesPerDay: 500, messagesPerDay: 1000 },
  contactPressure: [],
  ...overrides,
});

const action = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  agentId,
  command: 'artifacts.requestPublish',
  actionClass: 'content.publish',
  decision: 'allow',
  mandateId,
  mandateVersion: 4,
  intent: id === 42 ? 'Published Weekly Signal' : 'Requested a larger audience',
  shadow: null,
  reasons: ['Approved scope and level'],
  impact: { summary: 'Published', people: 2400 },
  ok: true,
  error: null,
  target: broadcastId,
  surface: 'artifact',
  at: `2026-11-06T${id === 42 ? '21:42' : '18:20'}:00.000Z`,
  undo: null,
  undoable: false,
  undoBlockedBy: null,
  undoneAt: null,
  undoneBy: null,
  undoResult: null,
  ...overrides,
});

const activity = (overrides: Record<string, unknown> = {}) => ({
  actions: [action(42), action(41, { decision: 'hold', reasons: ['Waiting for the veto window'], ok: false })],
  next: 40,
  ownedArtifacts: [broadcastId],
  heldConflicts: [
    {
      artifactId: broadcastId,
      artifactName: 'Weekly Signal',
      agentId: otherAgentId,
      agentName: 'Lifecycle assistant',
      kind: 'hold',
      until: '2026-11-06T23:00:00.000Z',
    },
  ],
  contactPressureSkipped: 3,
  ...overrides,
});

const comparisonAgent = (overrides: Record<string, unknown> = {}) => ({
  agentId,
  name: 'Newsletter assistant',
  status: 'active',
  outcomes: outcomes(),
  goalsMet: 1,
  goalsTotal: 2,
  guardian: { caps: 0, episodes: {} },
  ai: { calls: 12, inputTokens: 1000, outputTokens: 200, cost: 0.42 },
  mandates: [
    {
      mandateId,
      version: 4,
      validUntil: '2027-02-01T00:00:00.000Z',
      active: true,
      actions: { 'content.publish': { allow: 4, hold: 1, ask: 0, deny: 1, failed: 0 } },
      undone: 0,
      holds: { rejected: 0, ran: 0, pending: 0 },
    },
  ],
  ...overrides,
});

const otherComparisonAgent = () =>
  comparisonAgent({
    agentId: otherAgentId,
    name: 'Lifecycle assistant',
    outcomes: {
      broadcasts: {
        count: 1,
        sent: 1800,
        opened: 500,
        clicked: 180,
        unsubscribed: 8,
        complained: 0,
        bounced: 10,
      },
      direct: null,
      journeys: [],
      goals: [{ measure: 'email.open_rate', target: 0.4, direction: 'up', value: null, met: null, note: null }],
    },
    goalsMet: 0,
    goalsTotal: 1,
    ai: { calls: 0, inputTokens: 0, outputTokens: 0, cost: null },
    mandates: [],
  });

const comparison = (overrides: Record<string, unknown> = {}) => ({
  from,
  to,
  truncated: false,
  agents: [comparisonAgent(), otherComparisonAgent()],
  ...overrides,
});

const guardian = (overrides: Record<string, unknown> = {}) => ({
  guard: { cap: 2, irreversibleCap: 1, reason: 'A send far larger than usual.', since: '2026-11-05T09:00:00.000Z', episodeIds: ['gev_1'] },
  episodes: [
    {
      id: 'gev_1',
      kind: 'anomaly',
      action: 'hold',
      reason: 'A send was far larger than usual.',
      evidence: {},
      suspendedHolds: 0,
      at: '2026-11-05T09:00:00.000Z',
      clearedAt: null,
      clearedBy: null,
      clearedNote: null,
    },
  ],
  ...overrides,
});

const hosted = (overrides: Record<string, unknown> = {}) => ({
  hosted: {
    agentId,
    name: 'Newsletter assistant',
    description: 'Sends the weekly newsletter.',
    sponsor: { id: userId, name: 'Sam Rivera' },
    instructions: 'Write the newsletter.',
    schedule: '0 9 * * 1',
    scheduleText: 'Every Monday at 09:00',
    timeZone: 'UTC',
    scopes: ['artifacts:read'],
    enabled: true,
    budgets: { maxTokensPerRun: 100000, maxToolCallsPerRun: 50 },
    skills: [],
    modelProviderId: null,
    consecutiveFailures: 0,
    lastRunAt: '2026-11-02T09:00:00.000Z',
    nextRunAt: '2026-11-09T09:00:00.000Z',
    running: false,
    createdAt: '2026-10-02T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    triggerOnEvent: false,
  },
  runs: [
    {
      id: 'run_1',
      agentId,
      startedAt: '2026-11-02T09:00:00.000Z',
      finishedAt: '2026-11-02T09:02:00.000Z',
      status: 'ok',
      summary: 'Wrote and published the weekly newsletter.',
      toolCalls: 8,
      tokens: 12000,
      error: null,
      trigger: 'schedule',
      eventIds: [],
    },
  ],
  next: null,
  ...overrides,
});

const baseRespond = (name: string, input: any): unknown => {
  if (name === 'agents.get') return agent();
  if (name === 'agents.list') return { agents: [agent(), otherAgent()] };
  if (name === 'agents.report') return report();
  if (name === 'agents.mandate') return mandateResponse();
  if (name === 'workspace.autonomy') return autonomy();
  if (name === 'agents.activity') {
    if (input.before === 40) return { actions: [action(39, { intent: 'Ran the weekly send' })], next: null };
    return activity();
  }
  if (name === 'agents.compare') return comparison();
  if (name === 'agents.guardian') return guardian();
  if (name === 'agents.hostedRuns') return hosted();
  if (name === 'agents.pause') return agent({ status: 'paused', statusReason: null });
  if (name === 'agents.resume') return agent();
  if (name === 'agents.revoke') return agent({ status: 'revoked' });
  if (name === 'agents.update') return agent();
  if (name === 'members.list') return { members: [{ userId, name: 'Sam Rivera', role: 'owner' }] };
  throw new Error(`unexpected command ${name}`);
};

const names = () => h.calls.map((call) => call.name);
const calls = (name: string) => h.calls.filter((call) => call.name === name);
const pauseCalls = () => calls('agents.pause');
const reportCalls = () => calls('agents.report');
const activityCalls = () => calls('agents.activity');
const mandateCalls = () => calls('agents.mandate');

const renderAgent = () =>
  render(
    <ToastProvider>
      <AgentPage params={{ id: agentId }} />
    </ToastProvider>,
  );

const renderList = () =>
  render(
    <ToastProvider>
      <AgentsPage />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
  setWorkspaceTimeZone('UTC');
  h.calls.length = 0;
  h.held.length = 0;
  h.hold.clear();
  h.can = () => true;
  h.respond = baseRespond;
  h.pauseError = null;
  h.agentError = null;
  h.reportError = null;
  h.listError = null;
  h.compareError = null;
  h.mandateError = null;
  h.hostedError = null;
  window.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('agent reads (#509)', () => {
  it('reads one agent and one report for the first Overview, with the selected period', async () => {
    renderAgent();
    await screen.findByText('Broadcast sent people');

    expect(names().sort()).toEqual(['agents.get', 'agents.report']);
    expect(calls('agents.get')[0]!.input).toEqual({ id: agentId });
    expect(reportCalls()[0]!.input).toEqual({ agentId, from, to });
    expect(mandateCalls()).toHaveLength(0);
    expect(activityCalls()).toHaveLength(0);
    expect(calls('artifacts.get')).toHaveLength(0);
    expect(calls('artifacts.list')).toHaveLength(0);
    expect(screen.getByText(/Latest event in period: Unavailable/)).toBeTruthy();
    expect(screen.getByText(/30 Oct–5 Nov 2026 · UTC/)).toBeTruthy();
  });

  it('reads exactly one agents.mandate and one workspace.autonomy, never one read per mandate', async () => {
    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Mandate' }));
    await screen.findByText('Levels by action class');

    expect(mandateCalls()).toHaveLength(1);
    expect(mandateCalls()[0]!.input).toEqual({ agentId });
    expect(calls('workspace.autonomy')).toHaveLength(1);
    expect(calls('artifacts.get')).toHaveLength(0);
    expect(calls('artifacts.list')).toHaveLength(0);
    expect(calls('agents.get')).toHaveLength(1);
    expect(screen.queryByText(/Loading the agent mandate/)).toBeNull();
  });

  it('pages the activity timeline with the numeric cursor and never invents a to bound', async () => {
    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    await screen.findByText('Published Weekly Signal');

    expect(activityCalls()).toHaveLength(1);
    expect(activityCalls()[0]!.input).toEqual({ agentId, since: from, limit: 50 });
    expect(activityCalls()[0]!.input.to).toBeUndefined();
    expect(screen.getByText(/since Oct 30, 2026/)).toBeTruthy();
    expect(screen.getByText(/not a closed report period/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more actions' }));
    await waitFor(() => expect(activityCalls()).toHaveLength(2));
    expect(activityCalls()[1]!.input).toEqual({ agentId, since: from, limit: 50, before: 40 });
    await screen.findByText('Ran the weekly send');
    expect(screen.getAllByText('3 entries shown').length).toBeGreaterThan(0);
    expect(document.activeElement?.textContent).toContain('Activity · since Oct 30, 2026');
  });

  it('uses credentials from agents.get and reads hosted runs only when expanded', async () => {
    renderAgent();
    await screen.findByText('Broadcast sent people');
    const before = h.calls.length;

    fireEvent.click(screen.getByRole('tab', { name: 'Credentials' }));
    await screen.findByRole('heading', { name: 'Credentials' });
    expect(h.calls.length).toBe(before);
    expect(screen.getByRole('button', { name: `Copy ID tok_${'1'.repeat(32)}` })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Copy ID mcp_/ })).toBeNull();

    fireEvent.click(screen.getByText('Show the hosted agent and its runs'));
    await screen.findByText('Wrote and published the weekly newsletter.');
    expect(calls('agents.hostedRuns')).toHaveLength(1);
    expect(calls('agents.hostedRuns')[0]!.input).toEqual({ agentId, limit: 20 });
    expect(calls('agents.memory.list')).toHaveLength(0);
  });

  it('reads guardian episodes only when their details are expanded', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.get') return agent({ guard: guardian().guard });
      return baseRespond(name, input);
    };

    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    await screen.findByText('Published Weekly Signal');
    expect(calls('agents.guardian')).toHaveLength(0);

    fireEvent.click(screen.getByText('Guardian episodes'));
    await screen.findByText('A send was far larger than usual.');
    expect(calls('agents.guardian')).toHaveLength(1);
    expect(calls('agents.guardian')[0]!.input).toEqual({ agentId, limit: 50 });
  });
});

describe('one-click Pause (#509)', () => {
  it('pauses from the header in one click, with no dialog, and applies the returned agent', async () => {
    renderAgent();
    const pause = await screen.findByRole('button', { name: 'Pause' });
    fireEvent.click(pause);

    await waitFor(() => expect(pauseCalls()).toHaveLength(1));
    expect(pauseCalls()[0]!.input).toEqual({ id: agentId });
    expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByRole('button', { name: 'Resume' });
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
    expect(calls('agents.get')).toHaveLength(1);
  });

  it('keeps the agent active and offers Retry when Pause fails', async () => {
    h.pauseError = new Error('The pause was refused.');
    renderAgent();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    await screen.findByText(/Pause failed/);
    expect(screen.getByText(/Newsletter assistant remains active/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(pauseCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(pauseCalls()).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('keeps Pause in the header on every tab', async () => {
    renderAgent();
    await screen.findByText('Broadcast sent people');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();

    for (const tab of ['Activity', 'Mandate', 'Credentials', 'Overview']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    }
  });

  it('puts Pause on every active list row and pauses with one click', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Agents' });

    const pauseButtons = screen.getAllByRole('button', { name: 'Pause' });
    expect(pauseButtons).toHaveLength(2);
    fireEvent.click(pauseButtons[0]!);

    await waitFor(() => expect(pauseCalls()).toHaveLength(1));
    expect(pauseCalls()[0]!.input).toEqual({ id: agentId });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers no Pause to a viewer', async () => {
    h.can = (permission) => permission !== 'workspace:admin';
    renderAgent();
    await screen.findByText('Broadcast sent people');
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('mandate matrix (#509)', () => {
  it('shows granted, ceiling, guardian cap and explanation, and defaults missing levels to 1', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.get') return agent({ guard: guardian().guard });
      return baseRespond(name, input);
    };

    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Mandate' }));
    await screen.findByText('Levels by action class');

    const defaults = screen.getByRole('row', { name: /Audience publishing/ });
    expect(within(defaults).getByText('1 · Propose')).toBeTruthy();
    expect(within(defaults).getByText('Default')).toBeTruthy();

    const broadcasts = screen.getByRole('row', { name: /Broadcast sends/ });
    expect(within(broadcasts).getByText('3 · Act within limits')).toBeTruthy();
    expect(within(broadcasts).getByText('2 · Act with veto')).toBeTruthy();
    expect(within(broadcasts).getByText('1 · irreversible cap')).toBeTruthy();
    expect(within(broadcasts).getByText(/Above the workspace ceiling/)).toBeTruthy();
    expect(screen.getByText(/A level alone is not permission to execute/)).toBeTruthy();
    expect(screen.getByText(/Mon, Tue, Wed, Thu, Fri · 07:00–11:00/)).toBeTruthy();
    expect(screen.getByText(/5,000 recipients per send/)).toBeTruthy();
    expect(screen.getByText(/1 send\/day/)).toBeTruthy();
    expect(screen.getByText('Validity')).toBeTruthy();
  });

  it('says No active mandate instead of an empty level 0', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.mandate') return { agentId, mandate: null, outsideHours: null, asOf: '2026-11-07T08:30:00.000Z' };
      return baseRespond(name, input);
    };

    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Mandate' }));
    await screen.findAllByText('No active mandate');

    expect(screen.queryByText('Levels by action class')).toBeNull();
    expect(screen.queryByText('0 · Observe')).toBeNull();
    expect(calls('artifacts.get')).toHaveLength(0);
    expect(calls('artifacts.list')).toHaveLength(0);
  });

  it('shows outsideHours, shadow mode and the guardian cap separately', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.get') return agent({ guard: guardian().guard });
      if (name === 'agents.mandate')
        return mandateResponse({
          outsideHours: 'Now is outside the mandate’s working hours (07:00–11:00 Mon–Fri).',
          mandate: { id: mandateId, version: 5, content: mandateContent({ shadow: true }) },
        });
      return baseRespond(name, input);
    };

    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Mandate' }));
    await screen.findByText('Outside working hours');

    expect(screen.getByText(/Shadow mode is on/)).toBeTruthy();
    expect(screen.getByText(/The guardian has capped this agent/)).toBeTruthy();
    expect(screen.getAllByText(/Outside working hours, irreversible actions are capped at level 2/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('On').length).toBeGreaterThan(0);
  });
});

describe('comparison small multiples (#509)', () => {
  it('compares an explicit id list once on opening and never per agent', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Agent comparison values' });

    expect(names().sort()).toEqual(['agents.compare', 'agents.list']);
    expect(calls('agents.compare')).toHaveLength(1);
    expect(calls('agents.compare')[0]!.input).toEqual({ agentIds: [agentId, otherAgentId], from, to });
    expect(calls('agents.report')).toHaveLength(0);
    expect(calls('agents.mandate')).toHaveLength(0);
    expect(calls('agents.activity')).toHaveLength(0);
    expect(calls('agents.hostedRuns')).toHaveLength(0);
    expect(calls('agents.guardian')).toHaveLength(0);
  });

  it('waits for Apply when the selection changes', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Agent comparison values' });
    expect(calls('agents.compare')).toHaveLength(1);

    fireEvent.click(screen.getByText(/Choose agents/));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lifecycle assistant' }));
    expect(calls('agents.compare')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls('agents.compare')).toHaveLength(2));
    expect(calls('agents.compare')[1]!.input.agentIds).toEqual([agentId]);
  });

  it('uses a common scale per metric and keeps broadcast people apart from direct messages', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Agent comparison values' });

    const sentA = screen.getByRole('img', { name: 'Newsletter assistant · Sent: 2,400 people' });
    const sentB = screen.getByRole('img', { name: 'Lifecycle assistant · Sent: 1,800 people' });
    expect((sentA.firstElementChild as HTMLElement).style.width).toBe('100%');
    expect((sentB.firstElementChild as HTMLElement).style.width).toBe('75%');

    expect(screen.getAllByText('Broadcast outcomes · people').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Direct outcomes · messages').length).toBeGreaterThan(0);
    expect(screen.queryByText('2,440')).toBeNull();
    expect(screen.getByText(/Never added to direct messages|never added/i)).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Agent comparison values' });
    const row = within(table).getByRole('row', { name: /Newsletter assistant/ });
    expect(within(row).getByText('2,400')).toBeTruthy();
    expect(within(row).getByText('192')).toBeTruthy();
    expect(within(row).getByText('40')).toBeTruthy();
    expect(within(row).getByText('USD 0.42')).toBeTruthy();
  });

  it('keeps unknown AI cost unavailable and unknown goals not unmet', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Agent comparison values' });

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('0 met · 1 recorded')).toBeTruthy();
    expect(screen.getByText(/Goals without a measured value stay unknown, not unmet/)).toBeTruthy();
    expect(screen.getAllByText(/USD 0.42/).length).toBeGreaterThan(0);
  });

  it('respects a truncated comparison', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.compare') return comparison({ truncated: true });
      return baseRespond(name, input);
    };

    renderList();
    await screen.findByText(/More agents had activity/);
    expect(screen.getByText(/Compare explicit ids to see others/)).toBeTruthy();
  });
});

describe('agent states (#509)', () => {
  it('shows a section skeleton and aria-busy while the report loads', async () => {
    h.hold.add('agents.report');
    renderAgent();

    await waitFor(() => expect(document.querySelector('section[aria-busy="true"]')).toBeTruthy());
    expect(screen.getByLabelText('Loading agent overview')).toBeTruthy();
    expect(screen.getByLabelText('Period')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('keeps the period control and explains an empty period', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.report') return report({ actions: {}, outcomes: null, journeys: [], ownedArtifacts: [] });
      return baseRespond(name, input);
    };

    renderAgent();
    await screen.findByText('No recorded activity in this period');
    expect(screen.getByLabelText('Period')).toBeTruthy();
    expect(screen.getByText(/missing data is not a healthy result/i)).toBeTruthy();
    expect(screen.getByText(/no metric layer/i)).toBeTruthy();
  });

  it('shows an observed zero only when the read returned it', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.report')
        return report({
          actions: { draft: { allow: 0, hold: 0, ask: 0, deny: 0, failed: 0 } },
          outcomes: {
            broadcasts: { count: 0, sent: 0, opened: 0, clicked: 0, unsubscribed: 0, complained: 0, bounced: 0 },
            direct: { count: 0, sent: 0, opened: 0, clicked: 0, unsubscribed: 0, complained: 0, bounced: 0 },
            journeys: [],
            goals: [],
          },
        });
      return baseRespond(name, input);
    };

    renderAgent();
    await screen.findByText('Broadcast sent people');
    expect(screen.queryByText('No recorded activity in this period')).toBeNull();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getByText(/0 action rows in this period/)).toBeTruthy();
  });

  it('shows null values as an em dash and Unavailable, never as zero', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.report')
        return report({
          outcomes: {
            broadcasts: { count: 1, sent: null, opened: null, clicked: null, unsubscribed: null, complained: null, bounced: null },
            direct: null,
            journeys: [],
            goals: [{ measure: 'email.click_rate', target: null, direction: 'up', value: null, met: null, note: null }],
          },
        });
      return baseRespond(name, input);
    };

    renderAgent();
    await screen.findByText('Broadcast sent people');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No target/)).toBeTruthy();
  });

  it('keeps a report failure local with Retry and leaves the header intact', async () => {
    h.reportError = new Error('The report read failed.');
    renderAgent();
    await screen.findByText("Couldn't load the agent report");
    expect(screen.getByText('Newsletter assistant')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    const before = reportCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reportCalls().length).toBe(before + 1));
  });

  it('distinguishes a not-found agent from an empty period', async () => {
    h.agentError = new ApiError(404, 'not_found', 'Agent not found.');
    renderAgent();

    await screen.findByText('Agent not found');
    expect(screen.getByText(/not available at this address/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('No recorded activity in this period')).toBeNull();
  });

  it('never renders an epoch date for a missing mandate timestamp', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.mandate')
        return mandateResponse({
          asOf: '1970-01-01T00:00:00.000Z',
          mandate: {
            id: mandateId,
            version: 4,
            content: mandateContent({ validUntil: '1970-01-01T00:00:00.000Z' }),
          },
        });
      return baseRespond(name, input);
    };

    renderAgent();
    fireEvent.click(await screen.findByRole('tab', { name: 'Mandate' }));
    await screen.findByText('Levels by action class');

    expect(screen.getByText('Computed time unavailable')).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/1970|Jan 1, 1970/);
  });

  it('does not invent k-suppression for operational reads without a suppression contract', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.report') return report({ outcomes: null });
      return baseRespond(name, input);
    };

    renderAgent();
    await screen.findByText('Outcomes unavailable');
    expect(screen.getByText(/no k-suppression field/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/fewer than 5|k=5|k = 5/);
  });

  it('ignores a stale report response after a newer period is selected', async () => {
    h.hold.add('agents.report');
    renderAgent();
    await waitFor(() => expect(reportCalls()).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30' } });
    await waitFor(() => expect(reportCalls()).toHaveLength(2));

    h.held[0]!.resolve(report({ outcomes: outcomes() }));
    await waitFor(() => expect(screen.queryByText('2,400')).toBeNull());

    h.held[1]!.resolve(
      report({
        outcomes: {
          ...outcomes(),
          broadcasts: { ...outcomes().broadcasts, sent: 3000, clicked: 240 },
        },
      }),
    );
    await screen.findAllByText('3,000');
    expect(screen.queryByText('2,400')).toBeNull();
  });
});

describe('agent role restrictions (#509)', () => {
  it('issues zero protected reads without audit access and still loads the mandate', async () => {
    h.can = (permission) => permission !== 'audit:read';
    renderAgent();
    await screen.findByText('Restricted by your role');
    expect(names().sort()).toEqual(['agents.get']);

    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await screen.findByText('Restricted by your role');
    expect(activityCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Mandate' }));
    await screen.findByText('Levels by action class');
    expect(mandateCalls()).toHaveLength(1);
    expect(calls('workspace.autonomy')).toHaveLength(1);
  });

  it('issues no comparison read without audit access', async () => {
    h.can = (permission) => permission !== 'audit:read';
    renderList();
    await screen.findByText('Restricted by your role');

    expect(names()).toEqual(['agents.list']);
    expect(calls('agents.compare')).toHaveLength(0);
  });

  it('issues zero reads without artifact access', async () => {
    h.can = () => false;
    renderAgent();
    await screen.findByText('Restricted by your role');
    expect(h.calls).toEqual([]);
  });

  it('does not let a viewer mutate an agent', async () => {
    h.can = (permission) => permission === 'artifacts:read' || permission === 'audit:read';
    renderAgent();
    await screen.findByText('Broadcast sent people');
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(pauseCalls()).toHaveLength(0);
  });
});

describe('agent list states (#509)', () => {
  it('shows a local Retry when the inventory read fails', async () => {
    h.listError = new Error('The list failed.');
    renderList();
    await screen.findByText("Couldn't load this list");
    expect(screen.getByText('The list failed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('explains an empty inventory rather than showing a comparison', async () => {
    h.respond = (name, input) => {
      if (name === 'agents.list') return { agents: [] };
      return baseRespond(name, input);
    };
    renderList();
    await screen.findByText('No agents yet');
    expect(screen.queryByRole('table', { name: 'Agent comparison values' })).toBeNull();
    expect(calls('agents.compare')).toHaveLength(0);
  });
});
