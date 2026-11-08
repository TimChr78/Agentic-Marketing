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
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        if (name === 'webhooks.list') return { endpoints: [] };
        if (name === 'connections.list') return { connections: [] };
        if (name === 'journeys.simulate') return { version: 1, outcome: 'completed', converted: false, steps: [], entry: undefined };
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
    useReactFlow: () => ({ fitView: () => {}, screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
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
  h.rows = {};
  h.plan = { version: { content: { events: [] } } };
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

describe('journey simulation stays reachable (#528)', () => {
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
