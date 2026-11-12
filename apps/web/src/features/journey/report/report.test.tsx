import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceTimeZone } from '../../../ui/time';
import { JourneyGraph } from '../JourneyGraph';
import type { JNode } from '../model';
import { withNodeCounts } from './counts';
import { JourneyReport } from './JourneyReport';
import { funnelGate, REACH_NOTICE } from './model';

const journeyId = `jrn_${'a'.repeat(32)}`;
const periodFrom = '2026-10-30T00:00:00.000Z';
const periodTo = '2026-11-05T23:59:59.999Z';
const thirtyFrom = '2026-10-07T00:00:00.000Z';

type Call = { name: string; input: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  canRead: true,
  artifact: null as unknown,
  pinned: new Map<number, unknown>(),
  artifactMissing: false,
  artifactError: null as Error | null,
  stats: null as unknown,
  statsError: null as Error | null,
  pendingStats: false,
  funnel: null as unknown,
  funnelError: null as Error | null,
  pendingFunnel: false,
  holdout: null as unknown,
  holdoutError: null as Error | null,
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.get') {
          if (h.artifactMissing) throw new Error(`Artifact ${String(input.artifactId)} does not exist in this workspace.`);
          if (h.artifactError) throw h.artifactError;
          if (input.version !== undefined) {
            const pinned = h.pinned.get(Number(input.version));
            if (!pinned) throw new Error(`Version ${String(input.version)} does not exist.`);
            return pinned;
          }
          return h.artifact;
        }
        if (name === 'journeys.stats') {
          if (h.pendingStats) return new Promise(() => {});
          if (h.statsError) throw h.statsError;
          return h.stats;
        }
        if (name === 'analytics.journeyFunnel') {
          if (h.pendingFunnel) return new Promise(() => {});
          if (h.funnelError) throw h.funnelError;
          return h.funnel;
        }
        if (name === 'journeys.holdoutResult') {
          if (h.holdoutError) throw h.holdoutError;
          return h.holdout;
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({
    can: (permission: string) => (permission === 'artifacts:read' ? h.canRead : true),
    workspace: { id: 'ws_1' },
    user: { id: 'u1' },
  }),
  useWorkspace: () => ({
    can: (permission: string) => (permission === 'artifacts:read' ? h.canRead : true),
    workspace: { id: 'ws_1' },
    user: { id: 'u1' },
  }),
}));

vi.mock('../../../app/theme', () => ({ useResolvedTheme: () => 'light' }));

// The frozen chart primitive still renders its accessible table; the plot needs a browser.
vi.mock('../../../components/Chart', () => ({ Chart: () => null }));

// The canvas needs a browser; NodeView and the step list are what carry the counts.
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    ReactFlow: ({ nodes, nodeTypes }: { nodes: Node[]; nodeTypes: Record<string, React.ComponentType<unknown>> }) =>
      React.createElement(
        'div',
        null,
        nodes.map((node) => {
          const Step = nodeTypes[node.type ?? 'step']! as React.ComponentType<{ data: unknown; selected: boolean }>;
          return React.createElement(Step, { key: node.id, data: node.data, selected: false });
        }),
      ),
    Background: () => null,
    Controls: () => null,
    MarkerType: { ArrowClosed: 'arrow' },
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
  };
});

const linearNodes = (): JNode[] => [
  { id: 'n1', kind: 'trigger', label: 'Signed up', config: {}, next: [{ to: 'n2' }] },
  { id: 'n2', kind: 'email', label: 'Welcome email', config: {}, next: [{ to: 'n3' }] },
  { id: 'n3', kind: 'email', label: 'Follow-up', config: {}, next: [] },
];

const artifact = (overrides: Record<string, unknown> = {}) => ({
  id: journeyId,
  type: 'journey',
  name: 'Welcome journey',
  latestVersion: 1,
  publishedVersion: 1,
  version: {
    number: 1,
    state: 'published',
    content: { purpose: 'marketing', goal: 'Signup', nodes: linearNodes() },
  },
  layout: null,
  references: [],
  ...overrides,
});

const stats = (overrides: Record<string, unknown> = {}) => ({
  now: { ready: 10, waiting: 64, failed: 2, completed: 560, exited: 30, converted: 120 },
  waitingAt: { n2: 24, n3: 40 },
  reached: { n1: 1200, n2: 1080, n3: 940 },
  duplicatesSkipped: 2,
  missingKeySkipped: 1,
  ...overrides,
});

const funnel = (overrides: Record<string, unknown> = {}) => ({
  journeyId,
  basis: 'published',
  entered: 812,
  goalReached: 120,
  completed: 560,
  exited: 30,
  steps: [
    { step: 'n1', reached: 812, dropOff: 0, dropOffRate: 0 },
    { step: 'n2', reached: 720, dropOff: 92, dropOffRate: 92 / 812 },
    { step: 'n3', reached: 600, dropOff: 120, dropOffRate: 120 / 720 },
  ],
  meta: {
    timeZone: 'UTC',
    from: periodFrom,
    to: periodTo,
    freshness: '2026-11-06T21:42:00.000Z',
    suppressed: 0,
    k: 5,
    notes: [],
  },
  ...overrides,
});

const holdout = () => ({
  journeyId,
  controlGroup: { percent: 10, minSampleSize: 200, hashVersion: 'v1' },
  from: periodFrom,
  to: periodTo,
  control: { entered: 80, converted: 4, unsubscribed: 0, conversionRate: 0.05, unsubscribeRate: 0 },
  treatment: { entered: 720, converted: 48, unsubscribed: 3, conversionRate: 48 / 720, unsubscribeRate: 3 / 720 },
  absoluteLift: 0.0167,
  relativeLift: 0.3333,
  ci95: [0.001, 0.032],
  minSampleSizeMet: false,
  verdict: 'not_enough_data',
  note: 'Both arms need the minimum sample.',
});

const calls = (name: string) => h.calls.filter((call) => call.name === name);

const renderReport = (active = true) => render(<JourneyReport journeyId={journeyId} active={active} />);
const renderEmbeddedReport = () =>
  render(<JourneyReport journeyId={journeyId} artifact={artifact() as unknown as Parameters<typeof JourneyReport>[0]['artifact']} />);

const stepRow = (table: HTMLElement, label: string) => within(table).getByText(label).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
  setWorkspaceTimeZone('UTC');
  h.calls.length = 0;
  h.canRead = true;
  h.artifact = artifact();
  h.pinned.clear();
  h.artifactMissing = false;
  h.artifactError = null;
  h.stats = stats();
  h.statsError = null;
  h.pendingStats = false;
  h.funnel = funnel();
  h.funnelError = null;
  h.pendingFunnel = false;
  h.holdout = holdout();
  h.holdoutError = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('journey report reads (#507)', () => {
  it('runs exactly the host read and the two report reads for the default seven days', async () => {
    renderReport();
    await screen.findByText('Entered in period');
    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(1));

    expect(calls('artifacts.get')).toEqual([{ name: 'artifacts.get', input: { artifactId: journeyId } }]);
    expect(calls('journeys.stats')).toEqual([{ name: 'journeys.stats', input: { artifactId: journeyId } }]);
    expect(calls('analytics.journeyFunnel')).toEqual([
      { name: 'analytics.journeyFunnel', input: { journeyId, from: periodFrom, to: periodTo } },
    ]);
    expect(calls('artifacts.list')).toHaveLength(0);
    expect(calls('journeys.holdoutResult')).toHaveLength(0);
    expect(screen.getByText(/30 Oct–5 Nov 2026 · UTC/)).toBeTruthy();
    expect(screen.getByText('120 / 812 entries = 14.8%')).toBeTruthy();
  });

  it('reuses the artifact its host already loaded in embedded mode', async () => {
    renderEmbeddedReport();
    await screen.findByText('Entered in period');

    expect(calls('artifacts.get')).toHaveLength(0);
    expect(calls('journeys.stats')).toHaveLength(1);
    expect(calls('analytics.journeyFunnel')).toHaveLength(1);
  });

  it('reads the pinned published topology once when the latest draft differs', async () => {
    const draft = linearNodes().map((node) => ({ ...node, label: `${node.label} draft` }));
    h.artifact = artifact({
      latestVersion: 3,
      publishedVersion: 1,
      version: { number: 3, state: 'draft', content: { purpose: 'marketing', goal: 'Signup', nodes: draft } },
    });
    h.pinned.set(1, artifact());

    renderReport();
    await screen.findByText('Published v1 · counts across all versions');
    await screen.findByText('Entered in period');

    expect(calls('artifacts.get')).toEqual([
      { name: 'artifacts.get', input: { artifactId: journeyId } },
      { name: 'artifacts.get', input: { artifactId: journeyId, version: 1 } },
    ]);
    expect(screen.getAllByText('Welcome email').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Welcome email draft/)).toBeNull();
    // Aggregate counts cannot be attributed to one saved version.
    expect(screen.queryByText('Sequential event reach')).toBeNull();
    expect(screen.getByText(/Saved versions differ/)).toBeTruthy();
  });

  it('does not run any read while the Report tab is inactive', async () => {
    renderReport(false);
    expect(h.calls).toHaveLength(0);
    expect(screen.queryByText('Entered in period')).toBeNull();
  });

  it('makes no protected read without artifacts:read', async () => {
    h.canRead = false;
    renderReport();
    await screen.findByText('Restricted by your role');
    expect(h.calls).toHaveLength(0);
  });

  it('refreshes only the two report reads, never the artifact host read', async () => {
    renderReport();
    await screen.findByText('Entered in period');
    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(2));
    expect(calls('journeys.stats')).toHaveLength(2);
    expect(calls('artifacts.get')).toHaveLength(1);
  });

  it('changes the funnel period without re-reading the all-time stats', async () => {
    renderReport();
    await screen.findByText('Entered in period');
    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30' } });
    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(2));
    expect(calls('analytics.journeyFunnel')[1]!.input).toEqual({ journeyId, from: thirtyFrom, to: periodTo });
    expect(calls('journeys.stats')).toHaveLength(1);
    expect(screen.getAllByText(/7 Oct–5 Nov 2026 · UTC/).length).toBeGreaterThan(0);
  });

  it('never shows the previous period as current while the new read is pending', async () => {
    renderReport();
    await waitFor(() => expect(screen.getAllByText('812').length).toBeGreaterThan(0));
    h.pendingFunnel = true;
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30' } });

    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(2));
    expect(screen.queryAllByText('812')).toHaveLength(0);
    expect(document.querySelectorAll('section[aria-busy="true"]').length).toBeGreaterThanOrEqual(1);
  });

  it('omits the funnel read when the journey has no published version', async () => {
    h.artifact = artifact({
      publishedVersion: null,
      version: { number: 1, state: 'draft', content: { purpose: 'marketing', goal: 'Signup', nodes: linearNodes() } },
    });
    renderReport();
    await screen.findByText('No published topology. Draft preview has no live count overlay.');
    await waitFor(() => expect(calls('journeys.stats')).toHaveLength(1));
    expect(calls('analytics.journeyFunnel')).toHaveLength(0);
    expect((await screen.findAllByRole('button', { name: /^Copy ID n\d$/ })).length).toBeGreaterThan(0);
  });
});

describe('funnel gate (#507)', () => {
  const gate = (overrides: Partial<Parameters<typeof funnelGate>[0]> = {}) =>
    funnelGate({
      basis: 'published',
      latestVersion: 1,
      publishedVersion: 1,
      nodes: linearNodes(),
      steps: [
        { step: 'n1', reached: 812 },
        { step: 'n2', reached: 720 },
        { step: 'n3', reached: 600 },
      ],
      entered: 812,
      suppressed: 0,
      k: 5,
      ...overrides,
    });

  it('passes a single linear, mapped, monotone published graph', () => {
    const result = gate();
    expect(result.pass).toBe(true);
    if (!result.pass) return;
    expect(result.stages.map((stage) => [stage.label, stage.reached])).toEqual([
      ['Entered', 812],
      ['Welcome email', 720],
      ['Follow-up', 600],
    ]);
    expect(result.stages[1]!.difference).toBe(92);
    expect(result.stages[1]!.differenceRate).toBeCloseTo(92 / 812);
  });

  it('fails a reach basis even for a linear topology, and names the drop-off rule', () => {
    const result = gate({ basis: 'reach' });
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.reason).toBe('reach');
    expect(result.notice).toBe(REACH_NOTICE);
  });

  it('fails a branching graph and says so honestly', () => {
    const nodes: JNode[] = [
      { id: 'n1', kind: 'trigger', label: 'Signed up', config: {}, next: [{ to: 'n2' }] },
      { id: 'n2', kind: 'branch', label: 'Choose next step', config: {}, next: [{ to: 'n3' }, { to: 'n4' }] },
      { id: 'n3', kind: 'email', label: 'A', config: {}, next: [] },
      { id: 'n4', kind: 'email', label: 'B', config: {}, next: [] },
    ];
    const result = gate({
      nodes,
      steps: [
        { step: 'n1', reached: 812 },
        { step: 'n2', reached: 700 },
        { step: 'n3', reached: 400 },
        { step: 'n4', reached: 300 },
      ],
    });
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.reason).toBe('branching');
    expect(result.notice).toBe('This journey branches. Step reach is not a cohort funnel.');
  });

  it('fails a loop', () => {
    const nodes: JNode[] = [
      { id: 'n1', kind: 'trigger', label: 'Signed up', config: {}, next: [{ to: 'n2' }] },
      { id: 'n2', kind: 'email', label: 'Welcome email', config: {}, next: [{ to: 'n3' }] },
      { id: 'n3', kind: 'email', label: 'Follow-up', config: {}, next: [{ to: 'n2' }] },
    ];
    const result = gate({ nodes });
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.reason).toBe('looping');
  });

  it('fails an event step that is not in the published topology', () => {
    const result = gate({
      steps: [
        { step: 'n1', reached: 812 },
        { step: 'n2', reached: 720 },
        { step: 'old_node', reached: 10 },
      ],
    });
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.reason).toBe('unmapped');
  });

  it('fails a graph with a missing or suppressed stage', () => {
    const missing = gate({ steps: [{ step: 'n1', reached: 812 }] });
    expect(missing.pass).toBe(false);
    if (!missing.pass) expect(missing.reason).toBe('missing-stage');

    const suppressed = gate({ suppressed: 2 });
    expect(suppressed.pass).toBe(false);
    if (!suppressed.pass) expect(suppressed.reason).toBe('suppressed');
  });

  it('fails nonmonotone reach instead of clamping it', () => {
    const result = gate({
      steps: [
        { step: 'n1', reached: 812 },
        { step: 'n2', reached: 900 },
        { step: 'n3', reached: 600 },
      ],
    });
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.reason).toBe('nonmonotone');
  });

  it('fails any additional saved version because aggregate provenance is unavailable', () => {
    const result = gate({ latestVersion: 2 });
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.reason).toBe('versioned');
  });

  it('fails with no participants in the period', () => {
    const result = gate({ entered: 0 });
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.reason).toBe('empty');
  });

  it('draws a funnel only for a passing topology', async () => {
    renderReport();
    await waitFor(() => expect(screen.getAllByText('Sequential event reach').length).toBeGreaterThan(0));
    expect(screen.queryByText('This journey branches. Step reach is not a cohort funnel.')).toBeNull();
    expect(screen.getByText('Compatible linear topology; complete monotone steps. Event reach, not an entry cohort.')).toBeTruthy();
  });

  it('shows the honest branching notice and independent bars in the UI', async () => {
    const nodes: JNode[] = [
      { id: 'n1', kind: 'trigger', label: 'Signed up', config: {}, next: [{ to: 'n2' }] },
      { id: 'n2', kind: 'branch', label: 'Choose next step', config: {}, next: [{ to: 'n3' }, { to: 'n4' }] },
      { id: 'n3', kind: 'email', label: 'A', config: {}, next: [] },
      { id: 'n4', kind: 'email', label: 'B', config: {}, next: [] },
    ];
    h.artifact = artifact({
      version: { number: 1, state: 'published', content: { purpose: 'marketing', goal: 'Signup', nodes } },
    });
    h.funnel = funnel({
      basis: 'reach',
      steps: [
        { step: 'n1', reached: 812, dropOff: null, dropOffRate: null },
        { step: 'n2', reached: 700, dropOff: null, dropOffRate: null },
        { step: 'n3', reached: 400, dropOff: null, dropOffRate: null },
        { step: 'n4', reached: 300, dropOff: null, dropOffRate: null },
      ],
    });
    h.stats = stats({ reached: { n1: 812, n2: 700, n3: 400, n4: 300 }, waitingAt: { n2: 5 } });

    renderReport();
    await screen.findByText(REACH_NOTICE);
    expect(REACH_NOTICE).toContain('Drop-off is shown only for linear journeys.');
    expect(screen.queryAllByText('Sequential event reach')).toHaveLength(0);
    expect(screen.getAllByText('Participants reaching steps · selected period').length).toBeGreaterThan(0);
    expect(screen.getByRole('figure', { name: 'Participants reaching steps · selected period' })).toBeTruthy();
  });

  it('renders reach without drop-off whenever the server reports basis reach', async () => {
    // The saved topology looks linear, so only the server's basis can rule out a drop-off chain.
    h.funnel = funnel({
      basis: 'reach',
      steps: [
        { step: 'n1', reached: 812, dropOff: null, dropOffRate: null },
        { step: 'n2', reached: 720, dropOff: null, dropOffRate: null },
        { step: 'n3', reached: 600, dropOff: null, dropOffRate: null },
      ],
    });

    renderReport();
    await screen.findByText(REACH_NOTICE);
    expect(screen.queryAllByText('Sequential event reach')).toHaveLength(0);
    expect(screen.queryByRole('table', { name: 'Sequential event reach' })).toBeNull();
    expect(screen.getByRole('figure', { name: 'Participants reaching steps · selected period' })).toBeTruthy();
  });
});

describe('current, all-time and period counts stay separate (#507)', () => {
  it('labels current snapshot, period and all-time values separately', async () => {
    renderReport();
    await screen.findByText('Entered in period');
    expect(screen.getByText('Current participants')).toBeTruthy();
    expect(screen.getByText('Current participant state')).toBeTruthy();
    expect(screen.getByText(/Duplicate entries skipped \(all time\): 2/)).toBeTruthy();
    expect(screen.getByText(/Missing entry key skipped \(all time\): 1/)).toBeTruthy();
    expect(screen.getAllByText('812').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1,200').length).toBeGreaterThan(0);

    const table = screen.getByRole('table', { name: 'Journey steps' });
    expect(within(table).getByText('Period reach')).toBeTruthy();
    expect(within(table).getByText('All-time reach')).toBeTruthy();
    expect(within(table).getByText('Waiting now')).toBeTruthy();
  });

  it('keeps a missing node key unavailable and a returned zero an observed zero', async () => {
    h.stats = stats({ reached: { n1: 1200, n3: 0 }, waitingAt: { n2: 24 } });
    h.funnel = funnel({
      steps: [
        { step: 'n1', reached: 812, dropOff: 0, dropOffRate: 0 },
        { step: 'n2', reached: null, dropOff: null, dropOffRate: null },
        { step: 'n3', reached: 0, dropOff: 720, dropOffRate: 720 / 720 },
      ],
    });
    renderReport();
    await screen.findByText('Entered in period');

    const table = screen.getByRole('table', { name: 'Journey steps' });
    expect(stepRow(table, 'Welcome email').textContent).toContain('Unavailable');
    expect(stepRow(table, 'Welcome email').textContent).not.toMatch(/\b0\b/);
    expect(stepRow(table, 'Follow-up').textContent).toContain('0');
    expect(stepRow(table, 'Signed up').textContent).toContain('1,200');
  });

  it('shows an unresolved old step with a copy affordance and no draft name', async () => {
    h.stats = stats({ reached: { old_node: 64 }, waitingAt: {} });
    h.funnel = funnel({ steps: [{ step: 'old_node', reached: 64, dropOff: null, dropOffRate: null }] });
    renderReport();
    await screen.findByText('Historical step · name unavailable');
    expect(screen.getByRole('button', { name: 'Copy ID old_node' })).toBeTruthy();
    expect(screen.queryByText('Welcome email')).toBeNull();
  });

  it('keeps the funnel chart table and the step list in agreement', async () => {
    renderReport();
    await screen.findByText('Entered in period');

    const figure = screen.getByRole('figure', { name: 'Sequential event reach' });
    const chartTable = within(figure).getByRole('table', { name: 'Sequential event reach' });
    expect(within(chartTable).getByText('Welcome email')).toBeTruthy();
    expect(within(chartTable).getAllByText(/720/).length).toBeGreaterThan(0);

    const steps = screen.getByRole('table', { name: 'Journey steps' });
    expect(stepRow(steps, 'Welcome email').textContent).toContain('720');
  });

  it('never shows the raw journey id', async () => {
    renderReport();
    await screen.findByText('Entered in period');
    expect(document.body.textContent).not.toContain(journeyId);
  });
});

describe('canvas counts without fetches (#507)', () => {
  const nodes = (): Node[] => [
    { id: 'n1', position: { x: 0, y: 0 }, data: { label: 'Signed up' } },
    { id: 'n2', position: { x: 0, y: 100 }, data: { label: 'Welcome email' } },
  ];

  it('attaches counts without turning a missing key into zero', () => {
    const after = withNodeCounts(nodes(), { reached: { n1: 1200 }, waitingAt: { n1: 0 } }, 'All versions · reached all time / waiting now');
    expect(after[0]!.data.stats).toEqual({
      reached: 1200,
      waiting: 0,
      label: 'All versions · reached all time / waiting now',
    });
    expect(after[1]!.data.stats).toEqual({ label: 'All versions · reached all time / waiting now' });
  });

  it('renders canvas badges from the supplied counts and fetches nothing', () => {
    render(
      <JourneyGraph
        nodes={linearNodes()}
        counts={{ reached: { n1: 1200 }, waitingAt: { n1: 0 } }}
        countsLabel="All versions · reached all time / waiting now"
      />,
    );
    expect(h.calls).toHaveLength(0);
    expect(screen.getByText('All versions · reached all time / waiting now')).toBeTruthy();
    expect(screen.getAllByText('1,200 reached all time · 0 waiting now')).toHaveLength(1);
    expect(screen.getAllByText('Unavailable reached all time · Unavailable waiting now')).toHaveLength(2);
  });

  it('renders no badge at all when no counts are supplied', () => {
    render(<JourneyGraph nodes={linearNodes()} />);
    expect(h.calls).toHaveLength(0);
    expect(screen.queryByText(/reached all time/)).toBeNull();
  });
});

describe('journey report states (#507)', () => {
  it('shows section-sized skeletons while the report reads are loading', async () => {
    h.pendingFunnel = true;
    renderReport();
    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(1));
    expect(document.querySelectorAll('section[aria-busy="true"]').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Entered in period')).toBeNull();
  });

  it('keeps the period controls and explains an empty period', async () => {
    h.funnel = funnel({ entered: 0, goalReached: 0, completed: 0, exited: 0, steps: [] });
    h.stats = stats({
      now: { ready: 0, waiting: 0, failed: 0, completed: 0, exited: 0, converted: 0 },
      reached: {},
      waitingAt: {},
      duplicatesSkipped: 0,
      missingKeySkipped: 0,
    });
    renderReport();
    await screen.findByText('No recorded activity in this period. Choose another period; missing data is not a healthy result.');
    expect(screen.getByLabelText('Period')).toBeTruthy();
  });

  it('names an observed zero without inventing a denominator', async () => {
    h.funnel = funnel({ entered: 0, goalReached: 0, completed: 0, exited: 0, steps: [] });
    h.stats = stats({ now: { ready: 0, waiting: 5, failed: 0, completed: 0, exited: 0, converted: 0 }, reached: {}, waitingAt: { n2: 5 } });
    renderReport();
    await screen.findByText('Reached goal in period');
    expect(screen.getByText('No denominator available')).toBeTruthy();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('withholds suppressed reach with the server minimum and notes', async () => {
    h.funnel = funnel({
      steps: [{ step: 'n2', reached: null, dropOff: null, dropOffRate: null }],
      meta: { ...funnel().meta, suppressed: 2, notes: ['Step breakdown suppressed below k.'] },
    });
    renderReport();
    await screen.findByText('Values unavailable — fewer than 5 people.');
    expect(screen.getByText(/The server suppressed this breakdown/)).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Journey steps' });
    expect(stepRow(table, 'Welcome email').textContent).toContain('Unavailable');
  });

  it('never renders an epoch as freshness', async () => {
    h.funnel = funnel({ meta: { ...funnel().meta, freshness: '1970-01-01T00:00:00.000Z' } });
    renderReport();
    await screen.findByText('Entered in period');
    expect(screen.queryByText(/1970/)).toBeNull();
    expect(screen.getAllByText(/Latest event in period \(step events\): Unavailable/).length).toBeGreaterThan(0);
  });

  it('keeps a section failure local and retries only that section', async () => {
    h.statsError = new Error('stats unavailable');
    renderReport();
    await screen.findByText('Participant counts unavailable');
    expect(screen.getAllByText('Sequential event reach').length).toBeGreaterThan(0);
    expect(calls('journeys.stats')).toHaveLength(1);
    expect(calls('analytics.journeyFunnel')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls('journeys.stats')).toHaveLength(2));
    expect(calls('analytics.journeyFunnel')).toHaveLength(1);
  });

  it('distinguishes not found from an empty journey', async () => {
    h.artifactMissing = true;
    renderReport();
    await screen.findByText('This item is not available at this address.');
    expect(screen.getByRole('link', { name: 'Return to the list' })).toBeTruthy();
    expect(
      screen.queryByText('No recorded activity in this period. Choose another period; missing data is not a healthy result.'),
    ).toBeNull();
  });

  it('shows unavailable when a successful read cannot establish the metric', async () => {
    h.stats = {};
    renderReport();
    await screen.findByText('Values unavailable. This read does not provide the required metric or freshness. No estimate is substituted.');
  });

  it('loads the holdout only after expanding it, once for the period', async () => {
    h.artifact = artifact({
      version: {
        number: 1,
        state: 'published',
        content: { purpose: 'marketing', goal: 'Signup', controlGroup: { percent: 10, minSampleSize: 200 }, nodes: linearNodes() },
      },
    });
    renderReport();
    await screen.findByText('Entered in period');
    expect(calls('journeys.holdoutResult')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Holdout' }));
    await waitFor(() => expect(calls('journeys.holdoutResult')).toHaveLength(1));
    expect(calls('journeys.holdoutResult')[0]!.input).toEqual({ journeyId, from: periodFrom, to: periodTo });
    expect((await screen.findAllByText('Not enough data yet')).length).toBeGreaterThan(0);

    // Refresh reruns only the two report reads; the expanded holdout stays as it was.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls('analytics.journeyFunnel')).toHaveLength(2));
    expect(calls('journeys.holdoutResult')).toHaveLength(1);
  });
});
