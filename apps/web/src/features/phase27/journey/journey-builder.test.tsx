import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../../../app/api';
import { ToastProvider } from '../../../ui/toast';
import type { JNode, JourneyContent } from '../../journey/model';

type Call = { name: string; input: Record<string, unknown> };

const planId = `trp_${'a'.repeat(32)}`;

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: {} as Record<string, unknown[]>,
  plan: null as unknown,
  simulate: null as unknown,
  fits: [] as unknown[],
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.list') {
          const rows = h.rows[String(input.type ?? '')] ?? [];
          return { artifacts: rows, total: rows.length, nextCursor: null };
        }
        if (name === 'artifacts.get') return h.plan;
        if (name === 'purposes.list')
          return {
            source: 'published',
            purposes: [{ key: 'marketing_email', name: 'Marketing e-mail' }],
          };
        if (name === 'webhooks.list') return { endpoints: [] };
        if (name === 'connections.list') return { connections: [] };
        if (name === 'journeys.simulate') return h.simulate;
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'u1' }, workspace: { id: 'ws_1' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'u1' }, workspace: { id: 'ws_1' } }),
}));

vi.mock('../../../app/theme', () => ({ useResolvedTheme: () => 'light' }));

// The canvas needs a browser; the mocked React Flow renders each step and lets a test select it.
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    ReactFlow: ({
      nodes,
      nodeTypes,
      onNodeClick,
    }: {
      nodes: Node[];
      nodeTypes: Record<string, React.ComponentType<unknown>>;
      onNodeClick?: (event: unknown, node: Node) => void;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'journey-flow' },
        nodes.map((node) => {
          const Step = nodeTypes[node.type ?? 'step']! as React.ComponentType<{ data: unknown; selected: boolean }>;
          return React.createElement(
            'button',
            { key: node.id, type: 'button', 'data-node-id': node.id, onClick: () => onNodeClick?.({}, node) },
            React.createElement(Step, { data: node.data, selected: false }),
          );
        }),
      ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    MarkerType: { ArrowClosed: 'arrow' },
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
    applyNodeChanges: (_changes: unknown, nodes: Node[]) => nodes,
    useReactFlow: () => ({
      fitView: (opts: unknown) => {
        h.fits.push(opts);
      },
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    }),
  };
});

import { JourneyBuilder } from '../../journey/Builder';

const journeyId = `jrn_${'a'.repeat(32)}`;

const artifact = (content: JourneyContent) => ({
  id: journeyId,
  type: 'journey',
  name: 'Welcome journey',
  latestVersion: 1,
  publishedVersion: 1,
  version: { number: 1, state: 'published', content },
  layout: null,
  references: [],
});

function Harness({ initial, warnings = [] }: { initial: JourneyContent; warnings?: { nodeId: string | null; message: string }[] }) {
  const [content, setContent] = useState(initial);
  return (
    <ToastProvider>
      <JourneyBuilder
        artifact={artifact(initial) as never}
        content={content}
        onChange={(next) => setContent(next as JourneyContent)}
        readOnly={false}
        errors={{}}
        warnings={warnings.map((warning) => ({ ...warning, path: '' }))}
      />
      <output data-testid="content">{JSON.stringify(content)}</output>
    </ToastProvider>
  );
}

const content = () => JSON.parse(screen.getByTestId('content').textContent ?? '{}') as JourneyContent;

const positions = (nodes: JNode[]) => nodes.map((n) => n.position);

const moved = (): JNode[] => [
  { id: 'n1', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' }, next: [{ to: 'n2' }], position: { x: 900, y: 700 } },
  { id: 'n2', kind: 'email', label: 'Welcome e-mail', config: { template: '' }, position: { x: 420, y: 120 } },
  { id: 'n3', kind: 'exit', label: 'Exit', config: {}, position: { x: 1200, y: 900 } },
];

beforeEach(() => {
  localStorage.clear();
  setWorkspaceId('ws_1', { persist: false });
  h.calls.length = 0;
  h.fits.length = 0;
  h.rows = {};
  h.plan = { version: { content: { events: [] } } };
  h.simulate = { version: 1, outcome: 'completed', converted: false, steps: [], entry: undefined };
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('journey auto-layout action (#528)', () => {
  it('lays out in one action and one undo restores the previous positions and graph', async () => {
    render(<Harness initial={{ purpose: 'marketing_email', nodes: moved() }} />);
    const before = content();

    fireEvent.click(screen.getByRole('button', { name: 'Auto-layout' }));
    await waitFor(() => expect(positions(content().nodes)).not.toEqual(positions(before.nodes)));
    // A layout/fit is an instant view change, never a camera animation (#555 motion contract).
    expect(h.fits.at(-1)).toEqual({ padding: 0.2, duration: 0 });
    const after = content();
    expect(after.nodes.map((n) => ({ id: n.id, kind: n.kind, config: n.config, next: n.next }))).toEqual(
      before.nodes.map((n) => ({ id: n.id, kind: n.kind, config: n.config, next: n.next })),
    );

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(positions(content().nodes)).toEqual(positions(before.nodes)));
    expect(content().nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });

  it('is a labelled view action, not available to a read-only role', () => {
    render(
      <ToastProvider>
        <JourneyBuilder
          artifact={artifact({ purpose: 'marketing_email', nodes: moved() }) as never}
          content={{ purpose: 'marketing_email', nodes: moved() }}
          onChange={() => {}}
          readOnly
          errors={{}}
          warnings={[]}
        />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Auto-layout' })).toBeNull();
  });
});

describe('journey validation on the canvas and in Check (#528)', () => {
  const nodes = (): JNode[] => [
    { id: 'n1', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' }, next: [{ to: 'n2' }] },
    { id: 'n2', kind: 'email', label: 'Welcome e-mail', config: { template: '' }, next: [] },
    { id: 'n3', kind: 'wait', label: 'Orphan wait', config: { duration: 'P1D' } },
  ];

  it('shows the issue count and the existing check message on the affected step', () => {
    render(
      <Harness
        initial={{ purpose: 'marketing_email', nodes: nodes() }}
        warnings={[
          { nodeId: 'n2', message: 'The e-mail template is not live.' },
          { nodeId: null, message: 'The journey needs a published purpose.' },
        ]}
      />,
    );
    const step = screen.getByRole('button', { name: /Welcome e-mail/ });
    expect(step.textContent).toContain('Incomplete');
    expect(step.textContent).toContain('2 issues');
    expect(step.textContent).toContain('Choose the e-mail template to send.');
    // A graph-level issue belongs to the Check panel, never to an arbitrary step.
    expect(screen.queryByText('The journey needs a published purpose.')).toBeNull();
  });

  it('keeps the Check panel a complete list, including issues without a step', async () => {
    render(
      <Harness
        initial={{ purpose: 'marketing_email', nodes: nodes() }}
        warnings={[{ nodeId: null, message: 'The journey needs a published purpose.' }]}
      />,
    );
    expect(screen.getByRole('tab', { name: /Check/ }).textContent).toContain('3');
    fireEvent.click(screen.getByRole('tab', { name: /Check/ }));

    expect(screen.getByText('The journey needs a published purpose.')).toBeTruthy();
    expect(screen.getAllByText('Welcome e-mail').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Orphan wait').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('The journey needs a published purpose.')).toBeTruthy());
  });
});

describe('journey inspector reads (#528)', () => {
  const nodes = (): JNode[] => [
    { id: 'n1', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' }, next: [{ to: 'n2' }] },
    { id: 'n2', kind: 'email', label: 'First e-mail', config: { template: '' }, next: [{ to: 'n3' }] },
    { id: 'n3', kind: 'email', label: 'Second e-mail', config: { template: '' } },
  ];

  it('never resolves a node name with artifacts.get and loads each picker index once', async () => {
    h.rows = {
      email_template: [
        {
          id: `eml_${'b'.repeat(32)}`,
          type: 'email_template',
          name: 'Welcome',
          latestVersion: 1,
          latestState: 'published',
          publishedVersion: 1,
        },
      ],
      tracking_plan: [
        { id: planId, type: 'tracking_plan', name: 'Site plan', latestVersion: 1, latestState: 'published', publishedVersion: 1 },
      ],
    };
    render(<Harness initial={{ purpose: 'marketing_email', nodes: nodes() }} />);

    // The canvas alone reads no picker index and no artifact detail.
    expect(h.calls.filter((c) => c.name === 'artifacts.list')).toHaveLength(0);
    expect(h.calls.filter((c) => c.name === 'artifacts.get')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /First e-mail/ }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'artifacts.list' && c.input.type === 'email_template')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /Second e-mail/ }));
    expect(h.calls.filter((c) => c.name === 'artifacts.list' && c.input.type === 'email_template')).toHaveLength(1);

    // The tracking plan suggestion is one list and one detail read across repeated trigger selections.
    fireEvent.click(screen.getByRole('button', { name: /Signed up/ }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'artifacts.list' && c.input.type === 'tracking_plan')).toHaveLength(1));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'artifacts.get')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /First e-mail/ }));
    fireEvent.click(screen.getByRole('button', { name: /Signed up/ }));
    expect(h.calls.filter((c) => c.name === 'artifacts.list' && c.input.type === 'tracking_plan')).toHaveLength(1);
    expect(h.calls.filter((c) => c.name === 'artifacts.get')).toHaveLength(1);
  });

  it('reuses the endpoint and connection lists across repeated selections', async () => {
    const nodes: JNode[] = [
      { id: 'n1', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' }, next: [{ to: 'n2' }] },
      { id: 'n2', kind: 'webhook', label: 'Post it', config: { endpoint: '' }, next: [{ to: 'n3' }] },
      { id: 'n3', kind: 'action', label: 'Notify Slack', config: { connection: '', action: 'postMessage', input: {} } },
    ];
    render(<Harness initial={{ purpose: 'marketing_email', nodes }} />);

    fireEvent.click(screen.getByRole('button', { name: /Post it/ }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'webhooks.list')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Notify Slack/ }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'connections.list')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Post it/ }));
    fireEvent.click(screen.getByRole('button', { name: /Notify Slack/ }));
    expect(h.calls.filter((c) => c.name === 'webhooks.list')).toHaveLength(1);
    expect(h.calls.filter((c) => c.name === 'connections.list')).toHaveLength(1);
  });
});

describe('journey settings stay reachable (#528)', () => {
  it('keeps purpose, goal and the whole control-group setting', () => {
    render(
      <Harness
        initial={{
          purpose: 'marketing_email',
          goal: 'Activation',
          controlGroup: { percent: 10, minSampleSize: 200 },
          nodes: moved(),
        }}
      />,
    );
    expect(screen.getByText('Purpose')).toBeTruthy();
    expect(screen.getAllByText('Goal').length).toBeGreaterThan(0);
    expect(screen.getByText('Control group')).toBeTruthy();
    expect(screen.getByText('Share in control')).toBeTruthy();
    expect(screen.getByText('Minimum sample size')).toBeTruthy();
    expect(screen.getByText('Start a new scope if the percentage changes')).toBeTruthy();
    expect(screen.getByText('Step colours')).toBeTruthy();
    // One purposes list on mount; the settings read is unchanged by this work.
    expect(h.calls.filter((c) => c.name === 'purposes.list')).toHaveLength(1);
  });

  it('shows purpose names only, never the stored technical key', async () => {
    render(<Harness initial={{ purpose: 'marketing_email', goal: 'Activation', nodes: moved() }} />);
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Marketing e-mail'));
    const select = screen.getByRole('combobox', { name: 'Purpose' }) as HTMLSelectElement;
    expect(select.value).toBe('marketing_email');
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((label) => label.includes('marketing_email'))).toBe(false);
  });

  it('names an unresolved purpose and keeps the stored key in the copy affordance', async () => {
    render(<Harness initial={{ purpose: 'legacy_newsletter', nodes: moved() }} />);
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Unavailable purpose'));
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((label) => label.includes('legacy_newsletter'))).toBe(false);
    expect(screen.getByRole('button', { name: /^Purpose ID/ })).toBeTruthy();
  });

  it('exposes the steps as a readable summary beside the canvas', () => {
    render(<Harness initial={{ purpose: 'marketing_email', nodes: moved() }} />);
    const summary = screen.getByRole('region', { name: 'Journey steps' });
    expect(summary.textContent).toContain('Signed up');
    expect(summary.textContent).toContain('Welcome e-mail');
    expect(summary.textContent).toContain('Exit');
  });
});

describe('journey simulation stays reachable (#528)', () => {
  const simNodes = (): JNode[] => [
    {
      id: 'n1',
      kind: 'trigger',
      label: 'Order placed',
      config: { event: 'Order Placed', entryKey: { source: 'event_property', property: 'order_id' } },
      next: [{ to: 'n2' }],
    },
    {
      id: 'n2',
      kind: 'branch',
      label: 'Big order?',
      config: { condition: { trait: 'total', op: 'gt', value: 100 } },
      next: [{ to: 'n3' }, { to: 'n3' }],
    },
    {
      id: 'n3',
      kind: 'aiDecide',
      label: 'Which nudge?',
      config: { prompt: '', options: ['a', 'b'], fallback: 'a' },
      next: [{ to: 'n4' }, { to: 'n4' }],
    },
    { id: 'n4', kind: 'exit', label: 'Exit', config: {} },
  ];

  it('keeps events, entry-key sample, branch answers, AI answers and the result', async () => {
    h.simulate = {
      version: 1,
      outcome: 'completed',
      converted: true,
      steps: [{ after: 'PT0S', node: 'n1', label: 'Order placed', kind: 'trigger', detail: '' }],
      entry: { key: 'A-1', source: 'event_property', duplicate: false, note: '' },
    };
    render(<Harness initial={{ purpose: 'marketing_email', nodes: simNodes() }} />);
    fireEvent.click(screen.getByRole('tab', { name: /Simulate/ }));

    expect(screen.getByText('Add event')).toBeTruthy();
    expect(screen.getByText('Entry key sample')).toBeTruthy();
    expect(screen.getByText('Branch answers')).toBeTruthy();
    expect(screen.getByText('AI decisions')).toBeTruthy();
    expect(screen.getAllByText('Big order?').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Which nudge?').length).toBeGreaterThan(0);

    // Invalid sample JSON keeps the input and reports the existing local error without a read.
    const properties = screen.getByRole('textbox', { name: 'Properties (JSON)' });
    fireEvent.change(properties, { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    expect(screen.getByText('The sample event properties must be JSON.')).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'journeys.simulate')).toHaveLength(0);

    fireEvent.change(properties, { target: { value: '{"order_id":"A-1"}' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Big order?' }), { target: { value: 'yes' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Which nudge?' }), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'journeys.simulate')).toHaveLength(1));

    const call = h.calls.find((c) => c.name === 'journeys.simulate')!;
    expect(call.input).toMatchObject({
      artifactId: journeyId,
      version: 1,
      branches: { n2: 'yes' },
      ai: { n3: 'b' },
      sampleEvent: { name: 'Order Placed', properties: { order_id: 'A-1' } },
    });
    expect(await screen.findByText('Completed')).toBeTruthy();
    expect(screen.getByText('Reached the goal')).toBeTruthy();
    expect(screen.getAllByText('Order placed').length).toBeGreaterThan(0);
    expect(screen.getByText(/it would enter/)).toBeTruthy();
    expect(h.calls.filter((c) => /send/i.test(c.name))).toHaveLength(0);
    expect(h.calls.filter((c) => /model|ai\./i.test(c.name))).toHaveLength(0);
  });

  it('runs the saved version once, with no sending or model call', async () => {
    render(<Harness initial={{ purpose: 'marketing_email', nodes: moved() }} />);
    fireEvent.click(screen.getByRole('tab', { name: /Simulate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));

    await waitFor(() => expect(h.calls.filter((c) => c.name === 'journeys.simulate')).toHaveLength(1));
    const call = h.calls.find((c) => c.name === 'journeys.simulate')!;
    expect(call.input).toMatchObject({ artifactId: journeyId, version: 1 });
    expect(h.calls.filter((c) => /send/i.test(c.name))).toHaveLength(0);
    expect(h.calls.filter((c) => /model|ai\./i.test(c.name))).toHaveLength(0);
  });
});
