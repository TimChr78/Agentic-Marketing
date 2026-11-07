import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../src/ui/toast';

// #507 review: the canvas count overlay belongs to the live version only. A saved draft can have
// the same node ids as the published version, so comparing it with its own content proves nothing;
// the displayed version must itself be the published one.

type Call = { name: string; input: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  stats: null as unknown,
}));

const journeyId = `jrn_${'a'.repeat(32)}`;

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'journeys.stats') return h.stats;
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'u1' }, workspace: { id: 'ws_1' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'u1' }, workspace: { id: 'ws_1' } }),
}));

vi.mock('../src/app/theme', () => ({ useResolvedTheme: () => 'light' }));

// The canvas needs a browser; the mocked ReactFlow renders each NodeView so its badge is testable.
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
    MiniMap: () => null,
    MarkerType: { ArrowClosed: 'arrow' },
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
    applyNodeChanges: (_changes: unknown, nodes: Node[]) => nodes,
    useReactFlow: () => ({ fitView: () => {}, screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
  };
});

import { JourneyBuilder } from '../src/features/journey/Builder';
import type { JNode, JourneyContent } from '../src/features/journey/model';

const linearNodes = (): JNode[] => [
  { id: 'n1', kind: 'trigger', label: 'Signed up', config: {}, next: [{ to: 'n2' }] },
  { id: 'n2', kind: 'email', label: 'Welcome email', config: {}, next: [{ to: 'n3' }] },
  { id: 'n3', kind: 'email', label: 'Follow-up', config: {}, next: [] },
];

const draftNodes = (): JNode[] => [
  { id: 'n1', kind: 'trigger', label: 'Signed up', config: {}, next: [{ to: 'n4' }] },
  { id: 'n4', kind: 'email', label: 'New draft step', config: {}, next: [] },
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

const stats = () => ({
  now: { ready: 10, waiting: 64, failed: 2, completed: 560, exited: 30, converted: 120 },
  waitingAt: { n1: 0, n2: 24, n3: 40 },
  reached: { n1: 1200, n2: 1080, n3: 940 },
  duplicatesSkipped: 2,
  missingKeySkipped: 1,
});

const statsCalls = () => h.calls.filter((call) => call.name === 'journeys.stats');

const renderBuilder = (a: ReturnType<typeof artifact>) =>
  render(
    <ToastProvider>
      <JourneyBuilder
        artifact={a as never}
        content={(a.version as { content: JourneyContent }).content}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />
    </ToastProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  h.calls.length = 0;
  h.stats = stats();
});

afterEach(cleanup);

describe('builder count overlay provenance (#507 review)', () => {
  it('attaches counts for the published, unmodified version', async () => {
    renderBuilder(artifact());

    fireEvent.click(screen.getByRole('button', { name: 'Show stats' }));

    await waitFor(() => expect(statsCalls()).toHaveLength(1));
    expect(await screen.findByText('1,200 reached all time · 0 waiting now')).toBeTruthy();
    expect(screen.queryByText(/Counts are hidden/)).toBeNull();
  });

  it('attaches no counts to a saved but unpublished version', async () => {
    const draft = artifact({
      latestVersion: 2,
      publishedVersion: 1,
      version: { number: 2, state: 'draft', content: { purpose: 'marketing', goal: 'Signup', nodes: draftNodes() } },
    });
    renderBuilder(draft);

    fireEvent.click(screen.getByRole('button', { name: 'Show stats' }));

    expect(screen.getByText('Counts are hidden until you view the live version unmodified.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/reached all time/)).toBeNull());
    expect(statsCalls()).toHaveLength(0);
  });
});
