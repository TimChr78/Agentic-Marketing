import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, BarChart3, Play, Plus, Send, Trash2, Workflow } from 'lucide-react';
import { useStore } from '../mock/store';
import { exec } from '../api/commands';
import type { Journey, JourneyEdge, JourneyNode, NodeKind } from '../api/types';
import { AuthorBadge, Button, Card, PageHeader, Pill, cx, inputBase, inputCls, timeAgo } from '../components/ui';
import { useTheme } from '../lib/theme';
import { configSummary, kindMeta } from './nodeKinds';

export function Journeys() {
  const { journeys, openJourneyId, navigate } = useStore();
  const open = journeys.find((j) => j.id === openJourneyId);
  if (open)
    return (
      <ReactFlowProvider>
        <Builder key={open.id} journey={open} onBack={() => navigate('journeys', { journeyId: null })} />
      </ReactFlowProvider>
    );

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader eyebrow="Orchestration" title="Journeys">
        <Button variant="agent" onClick={() => useStore.getState().setCopilotOpen(true)}>
          Draft one with the copilot
        </Button>
      </PageHeader>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-semibold">Journey</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Version</th>
                <th className="px-4 py-2.5 text-right font-semibold">Entered</th>
                <th className="px-4 py-2.5 text-right font-semibold">Active</th>
                <th className="px-4 py-2.5 text-right font-semibold">Conversion</th>
                <th className="px-4 py-2.5 text-right font-semibold">Uplift vs holdout</th>
              </tr>
            </thead>
            <tbody className="num divide-y divide-line">
              {journeys.map((j) => {
                const latest = j.versions[j.versions.length - 1];
                return (
                  <tr key={j.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate('journeys', { journeyId: j.id })}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-semibold">
                        <Workflow size={15} className="text-muted" /> {j.name}
                      </div>
                      <div className="mt-0.5 text-[12px] text-muted">Goal: {j.goal}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={j.status === 'live' ? 'good' : j.status === 'draft' ? 'agent' : 'neutral'}>{j.status}</Pill>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        v{latest.number}
                        {latest.state !== 'published' && <Pill tone={latest.state === 'in_review' ? 'agent' : 'neutral'}>{latest.state.replace('_', ' ')}</Pill>}
                        <AuthorBadge author={latest.author} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">{j.metrics.entered.toLocaleString('en')}</td>
                    <td className="px-4 py-3 text-right">{j.metrics.active.toLocaleString('en')}</td>
                    <td className="px-4 py-3 text-right">{j.metrics.conversion ? `${j.metrics.conversion}%` : '—'}</td>
                    <td className="px-4 py-3 text-right text-good">{j.metrics.holdoutUplift ? `+${j.metrics.holdoutUplift} pts` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export type StepData = {
  node: JourneyNode;
  showStats: boolean;
  sim: 'none' | 'visited' | 'current';
  /** Overrides the derived config summary (the live builder's settings differ from the demo's). */
  summary?: string;
};

export const StepNode = memo(({ data, selected }: NodeProps<Node<StepData>>) => {
  const { node, showStats, sim, summary } = data;
  const meta = kindMeta[node.kind];
  const Icon = meta.icon;
  return (
    <div
      className={cx(
        'w-[230px] rounded-lg border px-3 py-2.5 shadow-sm',
        sim === 'none' ? 'bg-surface' : 'bg-accent-soft',
        sim === 'current' ? 'sim-active border-accent' : meta.ai ? 'border-agent/50' : 'border-line',
        selected && 'ring-2 ring-accent',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted" />
      <div className="flex items-center gap-2">
        <span className={cx('flex h-6 w-6 items-center justify-center rounded-md', meta.ai ? 'bg-agent-soft text-agent' : node.kind === 'trigger' ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted')}>
          <Icon size={14} />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{meta.label}</span>
      </div>
      <div className="mt-1.5 text-[13px] font-semibold leading-snug text-fg">{node.label}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{summary ?? configSummary(node)}</div>
      {showStats && node.stats && (
        <div className="num mt-2 flex gap-3 border-t border-line pt-1.5 text-[11px] text-muted">
          <span>
            <b className="text-fg">{node.stats.entered.toLocaleString('en')}</b> entered
          </span>
          {node.stats.active > 0 && (
            <span>
              <b className="text-accent">{node.stats.active.toLocaleString('en')}</b> waiting
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-muted" />
    </div>
  );
});

export const nodeTypes = { step: StepNode };
const palette: NodeKind[] = ['trigger', 'wait', 'waitEvent', 'branch', 'split', 'email', 'webhook', 'updateProfile', 'aiDecide', 'aiGenerate', 'goal', 'exit'];

function Builder({ journey, onBack }: { journey: Journey; onBack: () => void }) {
  const { profiles, approvalPolicy, toast } = useStore();
  const theme = useTheme();
  const [versionNo, setVersionNo] = useState(journey.versions[journey.versions.length - 1].number);
  const version = journey.versions.find((v) => v.number === versionNo) ?? journey.versions[journey.versions.length - 1];
  const [graph, setGraph] = useState<{ nodes: JourneyNode[]; edges: JourneyEdge[] }>({ nodes: version.nodes, edges: version.edges });
  const [selected, setSelected] = useState<string | null>(null);
  // React Flow (controlled) needs measured sizes fed back, or nodes stay hidden.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [showStats, setShowStats] = useState(true);
  const [sim, setSim] = useState<{ path: { nodeId: string; label: string; clock: string; note: string }[]; step: number; profile: string } | null>(null);
  const [simProfile, setSimProfile] = useState(profiles[2]?.id ?? '');
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setGraph({ nodes: version.nodes, edges: version.edges });
    // Only reset the working copy when the viewed version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionNo]);

  const persist = useCallback(
    (next: { nodes: JourneyNode[]; edges: JourneyEdge[] }) => {
      setGraph(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const res = await exec<{ version: number }>('journeys.updateDraft', { journeyId: journey.id, ...next });
        if (res.version !== versionNo) {
          setVersionNo(res.version);
          toast(`Editing created draft v${res.version}`, 'neutral');
        }
      }, 700);
    },
    [journey.id, versionNo, toast],
  );

  const simIndex = sim ? sim.path.slice(0, sim.step + 1).map((p) => p.nodeId) : [];
  const rfNodes: Node<StepData>[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'step',
        position: n.position,
        data: { node: n, showStats, sim: !sim ? 'none' : sim.path[sim.step]?.nodeId === n.id ? 'current' : simIndex.includes(n.id) ? 'visited' : 'none' },
        selected: n.id === selected,
        measured: measured[n.id],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes, showStats, sim, selected, measured],
  );
  const rfEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const hot = sim && simIndex.includes(e.source) && simIndex.includes(e.target);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: 'smoothstep',
          animated: !!hot,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: hot ? { stroke: 'var(--accent)', strokeWidth: 2 } : undefined,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.edges, sim],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<StepData>>[]) => {
      const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
      if (dims.length)
        setMeasured((m) => ({ ...m, ...Object.fromEntries(dims.map((c) => [(c as { id: string }).id, (c as { dimensions: { width: number; height: number } }).dimensions])) }));
      if (dims.length === changes.length) return;
      const moved = applyNodeChanges(changes, rfNodes);
      const nodes = graph.nodes.map((n) => ({ ...n, position: moved.find((m) => m.id === n.id)?.position ?? n.position }));
      const isDragEnd = changes.some((c) => c.type === 'position' && c.dragging === false);
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removed.length) {
        persist({ nodes: nodes.filter((n) => !removed.includes(n.id)), edges: graph.edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)) });
      } else if (isDragEnd) persist({ nodes, edges: graph.edges });
      else setGraph({ nodes, edges: graph.edges });
    },
    [rfNodes, graph, persist],
  );

  const onConnect = useCallback(
    (c: Connection) => persist({ nodes: graph.nodes, edges: [...graph.edges, { id: `${c.source}-${c.target}`, source: c.source, target: c.target }] }),
    [graph, persist],
  );

  function addNode(kind: NodeKind) {
    const anchor = graph.nodes.find((n) => n.id === selected) ?? graph.nodes[graph.nodes.length - 1];
    const id = `n${Date.now().toString(36).slice(-4)}`;
    const node: JourneyNode = {
      id,
      kind,
      label: kindMeta[kind].label,
      config: { ...kindMeta[kind].defaults },
      position: anchor ? { x: anchor.position.x, y: anchor.position.y + 130 } : { x: 260, y: 0 },
    };
    persist({ nodes: [...graph.nodes, node], edges: anchor ? [...graph.edges, { id: `${anchor.id}-${id}`, source: anchor.id, target: id }] : graph.edges });
    setSelected(id);
  }

  function updateNode(id: string, patch: Partial<JourneyNode>) {
    persist({ nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)), edges: graph.edges });
  }

  async function runSim() {
    setSelected(null);
    const res = await exec<{ path: { nodeId: string; label: string; clock: string; note: string }[]; profile: string }>('journeys.simulate', {
      journeyId: journey.id,
      profileId: simProfile,
    });
    setSim({ ...res, step: 0 });
    res.path.forEach((_, i) => setTimeout(() => setSim((s) => (s ? { ...s, step: i } : s)), i * 850));
  }

  async function publish() {
    const res = await exec<{ status: string; version?: number }>('journeys.requestPublish', { journeyId: journey.id, note: 'Edited in journey builder' });
    if (res.status === 'published') toast(`Published v${res.version}`, 'good');
    else if (res.status === 'awaiting_approval') toast('Sent for approval (workspace policy)', 'agent');
    else toast('Already published', 'neutral');
  }

  const sel = graph.nodes.find((n) => n.id === selected);
  const latest = journey.versions[journey.versions.length - 1];

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <Button variant="ghost" onClick={onBack} aria-label="Back to journeys">
          <ArrowLeft size={16} />
        </Button>
        <div className="mr-2 min-w-0">
          <div className="truncate text-[15px] font-semibold">{journey.name}</div>
          <div className="text-[11px] text-muted">Goal: {journey.goal} · purpose {journey.purpose}</div>
        </div>
        <select id="journey-version" className={inputBase} value={versionNo} onChange={(e) => { setSim(null); setVersionNo(Number(e.target.value)); }}>
          {journey.versions.map((v) => (
            <option key={v.number} value={v.number}>
              v{v.number} · {v.state.replace('_', ' ')} · {v.author.type === 'agent' ? '🤖 ' : ''}
              {v.author.name}
            </option>
          ))}
        </select>
        <AuthorBadge author={version.author} />
        <span className="text-[11px] text-muted">{timeAgo(version.createdAt)}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant={showStats ? 'secondary' : 'ghost'} onClick={() => setShowStats(!showStats)}>
            <BarChart3 size={14} /> Stats
          </Button>
          <select id="sim-profile" className={cx(inputBase, 'w-[150px]')} value={simProfile} onChange={(e) => setSimProfile(e.target.value)} aria-label="Profile to simulate">
            {profiles.slice(0, 12).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button onClick={runSim}>
            <Play size={14} /> Simulate
          </Button>
          <Button variant="primary" onClick={publish} disabled={latest.state === 'published' || latest.state === 'in_review'}>
            <Send size={14} /> {approvalPolicy === 'none' ? 'Publish' : 'Request publish'}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface p-2 md:w-[170px] md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
          <div className="eyebrow hidden px-1 pb-1 md:block">Add step</div>
          {palette.map((k) => {
            const m = kindMeta[k];
            return (
              <button
                key={k}
                onClick={() => addNode(k)}
                className={cx('flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium hover:bg-surface-2', m.ai ? 'text-agent' : 'text-fg')}
                title={`Add ${m.label} after the selected step`}
              >
                <m.icon size={14} /> {m.label}
                <Plus size={12} className="ml-auto hidden text-muted md:block" />
              </button>
            );
          })}
        </div>

        <div className="relative min-h-[420px] flex-1">
          <div className="absolute inset-0">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            colorMode={theme}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!hidden lg:!block" />
          </ReactFlow>
          </div>
          {version.state !== 'draft' && (
            <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] text-muted shadow-sm">
              Viewing v{version.number} ({version.state.replace('_', ' ')}). Edits create a new draft.
            </div>
          )}
        </div>

        <div className="shrink-0 overflow-y-auto border-t border-line bg-surface md:w-[300px] md:border-l md:border-t-0">
          {sim ? (
            <div className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="eyebrow">Simulation · virtual clock</div>
                  <div className="font-semibold">{sim.profile}</div>
                </div>
                <Button variant="ghost" onClick={() => setSim(null)}>
                  Close
                </Button>
              </div>
              <ol className="space-y-2">
                {sim.path.slice(0, sim.step + 1).map((p, i) => (
                  <li key={i} className="flash-in rounded-md border border-line p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold">{p.label}</span>
                      <span className="num font-mono text-[11px] text-accent">{p.clock}</span>
                    </div>
                    <div className={cx('mt-0.5 text-[12px]', p.note.startsWith('Suppressed') ? 'text-bad' : 'text-muted')}>{p.note}</div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[11px] text-muted">Dry run: no messages are sent. Agents use the same simulation via journeys.simulate.</p>
            </div>
          ) : sel ? (
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <div className="eyebrow">{kindMeta[sel.kind].label}</div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    persist({ nodes: graph.nodes.filter((n) => n.id !== sel.id), edges: graph.edges.filter((e) => e.source !== sel.id && e.target !== sel.id) });
                    setSelected(null);
                  }}
                  aria-label="Delete step"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-muted">Label</span>
                <input id={`label-${sel.id}`} className={inputCls} value={sel.label} onChange={(e) => updateNode(sel.id, { label: e.target.value })} />
              </label>
              {Object.entries(sel.config).map(([k, v]) => (
                <label key={k} className="block">
                  <span className="mb-1 block font-mono text-[11px] text-muted">{k}</span>
                  <input
                    id={`cfg-${sel.id}-${k}`}
                    className={cx(inputCls, 'font-mono')}
                    value={String(v)}
                    onChange={(e) => updateNode(sel.id, { config: { ...sel.config, [k]: typeof v === 'number' ? Number(e.target.value) : e.target.value } })}
                  />
                </label>
              ))}
              {kindMeta[sel.kind].ai && (
                <p className="rounded-md bg-agent-soft p-2.5 text-[12px] text-agent">
                  AI steps run asynchronously with a fallback path, schema-validated output and a decision log. Only attributes marked “AI visible” reach the model.
                </p>
              )}
              {sel.kind === 'email' && (
                <p className="rounded-md bg-surface-2 p-2.5 text-[12px] text-muted">
                  The send gateway checks the lawful basis for <code className="font-mono">{String(sel.config.purpose)}</code>, suppressions and frequency caps before every send.
                </p>
              )}
            </div>
          ) : (
            <div className="p-4 text-[13px] text-muted">
              <div className="eyebrow mb-2">Inspector</div>
              Select a step to edit it, drag between handles to connect steps, or add a step from the palette. Press <kbd className="rounded border border-line px-1 font-mono text-[11px]">⌫</kbd> to delete the selected step.
              <div className="mt-4 rounded-md border border-line p-3">
                <div className="eyebrow mb-1">This journey</div>
                <div className="num grid grid-cols-2 gap-2 text-[12px]">
                  <span>Entered</span>
                  <b className="text-right text-fg">{journey.metrics.entered.toLocaleString('en')}</b>
                  <span>Conversion</span>
                  <b className="text-right text-fg">{journey.metrics.conversion || '—'}%</b>
                  <span>Uplift vs holdout</span>
                  <b className="text-right text-good">+{journey.metrics.holdoutUplift} pts</b>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
