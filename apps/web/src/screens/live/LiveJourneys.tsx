import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, applyNodeChanges, type Connection, type Edge, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, ArrowLeft, BarChart3, Play, Plus, Send, Trash2, Workflow } from 'lucide-react';
import type { JourneyNode, NodeKind } from '../../api/types';
import { Button, Card, Pill, cx, inputBase, inputCls, timeAgo } from '../../components/ui';
import { useTheme } from '../../lib/theme';
import { nodeTypes, type StepData } from '../Journeys';
import { api, errText, type Out } from '../liveApi';
import { kindMeta } from '../nodeKinds';

// Journeys on the real API. The canvas edits the same JSON an agent edits (nodes with `next`
// edges); saving is artifacts.updateDraft, so drafts, versions and approvals apply as usual.

type Artifact = Out<'artifacts.get'>;
type Warning = { nodeId: string | null; path: string; message: string };
interface LiveNode {
  id: string;
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;
  next?: { to: string; label?: string }[];
  position?: { x: number; y: number };
}
interface Content {
  purpose: string;
  goal?: string;
  nodes: LiveNode[];
}

/** Every step kind the runtime can run. */
const PALETTE: NodeKind[] = ['trigger', 'wait', 'waitEvent', 'branch', 'split', 'aiDecide', 'aiGenerate', 'email', 'sms', 'push', 'updateProfile', 'webhook', 'action', 'transform', 'goal', 'exit'];
const DEFAULTS: Partial<Record<NodeKind, Record<string, unknown>>> = {
  trigger: { event: 'Signed Up', reentry: 'once' },
  wait: { duration: 'P1D' },
  waitEvent: { event: 'Order Completed', timeout: 'P2D' },
  goal: { event: 'Order Completed', within: 'P14D' },
  branch: { condition: { trait: 'city', op: 'eq', value: 'Aarhus' } },
  split: { weights: [50, 50] },
  email: { template: '' },
  sms: { template: '' },
  push: { template: '' },
  updateProfile: { trait: 'lifecycle', value: 'engaged' },
  aiDecide: { prompt: '', options: ['vip', 'standard'], fallback: 'standard', timeout: 'PT5M' },
  aiGenerate: { prompt: '', timeout: 'PT5M' },
  webhook: { endpoint: '' },
  action: { connection: '', action: 'postMessage', input: '{"text": "New lead: " & profile.id}', timeout: 'PT10M' },
  transform: { set: 'total', expression: '$sum(event.properties.products.price)' },
  exit: {},
};
const EDGE_LABELS: Partial<Record<NodeKind, string[]>> = {
  branch: ['yes', 'no'],
  waitEvent: ['matched', 'timeout'],
  goal: ['converted', 'timeout'],
  action: ['ok', 'error'],
};

function summary(n: LiveNode): string {
  const c = n.config as Record<string, any>;
  switch (n.kind) {
    case 'trigger':
      return c.segment ? `entered ${String(c.segment).slice(0, 12)}… · ${c.reentry}` : `on ${c.event} · ${c.reentry ?? 'once'}`;
    case 'wait':
      return String(c.duration);
    case 'waitEvent':
      return `${c.event} · timeout ${c.timeout}`;
    case 'goal':
      return `${c.event} within ${c.within}`;
    case 'branch':
      return c.segment ? `in ${String(c.segment).slice(0, 12)}…` : JSON.stringify(c.condition ?? {});
    case 'split':
      return (c.weights ?? []).map((w: number, i: number) => `${String.fromCharCode(65 + i)} ${w}`).join(' · ');
    case 'email':
    case 'sms':
    case 'push':
      return c.template ? String(c.template).slice(0, 16) + '…' : 'choose a template';
    case 'updateProfile':
      return `${c.trait} = ${JSON.stringify(c.value)}`;
    case 'webhook':
      return c.endpoint ? `to ${String(c.endpoint).slice(0, 12)}…` : 'choose an endpoint';
    case 'action':
      return c.connection ? `${c.action} via ${String(c.connection).slice(0, 12)}…` : 'choose a connection';
    case 'transform':
      return `vars.${c.set} = ${String(c.expression).slice(0, 40)}`;
    case 'aiDecide':
      return c.prompt ? `${(c.options ?? []).join(' | ')} · fallback ${c.fallback}` : 'choose a decide prompt';
    case 'aiGenerate':
      return c.prompt ? `fills content.* from ${String(c.prompt).slice(0, 12)}…` : 'choose a generate prompt';
    default:
      return '';
  }
}

/** Edges as stored (`next`), plus the implicit "continue with the following node". */
type FlowEdge = { source: string; target: string; label?: string; implicit: boolean };
function edgesOf(nodes: LiveNode[]): FlowEdge[] {
  return nodes.flatMap((n, i): FlowEdge[] => {
    if (n.next) return n.next.map((e, k) => ({ source: n.id, target: e.to, label: e.label ?? EDGE_LABELS[n.kind]?.[k] ?? (n.kind === 'split' ? `variant ${String.fromCharCode(65 + k)}` : n.kind === 'aiDecide' ? (n.config.options as string[] | undefined)?.[k] : undefined), implicit: false }));
    const following = nodes[i + 1];
    return n.kind !== 'exit' && following ? [{ source: n.id, target: following.id, implicit: true }] : [];
  });
}

/** Makes every edge explicit, so the canvas and the stored JSON always agree. */
function materialize(nodes: LiveNode[]): LiveNode[] {
  const edges = edgesOf(nodes);
  return nodes.map((n) => ({ ...n, next: edges.filter((e) => e.source === n.id).map((e) => ({ to: e.target })) }));
}

export function LiveJourneys({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Out<'artifacts.list'>['artifacts']>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [createdWarnings, setCreatedWarnings] = useState<Warning[]>([]);
  const load = useCallback(async () => {
    try {
      setList((await api.call('artifacts.list', {})).artifacts.filter((a) => a.type === 'journey'));
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  if (open)
    return (
      <ReactFlowProvider>
        <Builder
          id={open}
          initialWarnings={createdWarnings}
          onError={onError}
          onBack={() => {
            setOpen(null);
            setCreatedWarnings([]);
            void load();
          }}
        />
      </ReactFlowProvider>
    );

  return (
    <Card title="Journeys" action={<Pill>{list.length}</Pill>}>
      <form
        className="flex gap-2 border-b border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.call('artifacts.create', {
              type: 'journey',
              name: name || 'New journey',
              content: {
                purpose: 'marketing_email',
                nodes: [
                  { id: 'trigger', kind: 'trigger', label: 'Trigger', config: DEFAULTS.trigger, position: { x: 0, y: 0 } },
                  { id: 'done', kind: 'exit', label: 'Exit', config: {}, position: { x: 0, y: 160 } },
                ],
              },
            });
            setName('');
            setCreatedWarnings(r.warnings);
            setOpen(r.artifactId);
          } catch (err) {
            onError(errText(err));
          }
        }}
      >
        <input className={cx(inputCls, 'min-w-0 flex-1')} placeholder="New journey name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New journey name" />
        <Button variant="primary">
          <Plus size={14} /> Create
        </Button>
      </form>
      <ul className="divide-y divide-line">
        {list.map((j) => (
          <li key={j.id}>
            <button
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2"
              onClick={() => {
                setCreatedWarnings([]);
                setOpen(j.id);
              }}
            >
              <Workflow size={15} className="text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{j.name}</span>
                <span className="text-[11px] text-muted">
                  v{j.latestVersion}
                  {j.publishedVersion ? ` · live v${j.publishedVersion}` : ''} · {timeAgo(Date.parse(j.updatedAt))}
                </span>
              </span>
              <Pill tone={j.publishedVersion ? 'good' : 'neutral'}>{j.publishedVersion ? 'live' : j.latestState.replace('_', ' ')}</Pill>
            </button>
          </li>
        ))}
        {!list.length && <li className="px-4 py-4 text-[13px] text-muted">No journeys yet. Create one, or ask an agent to draft one over MCP.</li>}
      </ul>
    </Card>
  );
}

function Builder({
  id,
  initialWarnings = [],
  onBack,
  onError,
}: {
  id: string;
  initialWarnings?: Warning[];
  onBack: () => void;
  onError: (m: string) => void;
}) {
  const theme = useTheme();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [hash, setHash] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [stats, setStats] = useState<Out<'journeys.stats'> | null>(null);
  const [showStats, setShowStats] = useState(true);
  const [sim, setSim] = useState<Out<'journeys.simulate'> | null>(null);
  const [people, setPeople] = useState<Out<'profiles.list'>['profiles']>([]);
  const [simProfile, setSimProfile] = useState('');
  const [status, setStatus] = useState('');
  const [warnings, setWarnings] = useState<Warning[]>(initialWarnings);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(async () => {
    try {
      const a = await api.call('artifacts.get', { artifactId: id });
      setArtifact(a);
      setContent(a.version.content as Content);
      setHash(a.version.contentHash);
      setStats(a.publishedVersion ? await api.call('journeys.stats', { artifactId: id }) : null);
    } catch (e) {
      onError(errText(e));
    }
  }, [id, onError]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    api.call('profiles.list', { limit: 30 }).then((r) => setPeople(r.profiles), () => {});
  }, []);

  const save = useCallback(
    (next: Content) => {
      setContent(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          const r = await api.call('artifacts.updateDraft', { artifactId: id, content: next, expectedContentHash: hash });
          setHash(r.contentHash);
          setWarnings(r.warnings);
          setStatus(`Saved draft v${r.version}`);
          onError('');
          if (artifact && r.version !== artifact.version.number) await reload();
        } catch (e) {
          setStatus('Not saved');
          onError(errText(e));
        }
      }, 600);
    },
    [id, hash, artifact, reload, onError],
  );

  const nodes = content?.nodes ?? [];
  const simVisited = new Set(sim?.steps.map((s) => s.node));
  const rfNodes: Node<StepData>[] = useMemo(
    () =>
      nodes.map((n, i) => ({
        id: n.id,
        type: 'step',
        position: n.position ?? { x: 0, y: i * 150 },
        data: {
          node: { ...n, config: {}, position: n.position ?? { x: 0, y: 0 }, stats: stats ? { entered: stats.reached[n.id] ?? 0, active: stats.waitingAt[n.id] ?? 0 } : undefined } as JourneyNode,
          showStats: showStats && !!stats,
          sim: sim ? (simVisited.has(n.id) ? 'visited' : 'none') : 'none',
          summary: summary(n),
          warning:
            warnings
              .filter((w) => w.nodeId === n.id)
              .map((w) => w.message)
              .join('; ') || undefined,
        },
        selected: n.id === selected,
        measured: measured[n.id],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, stats, showStats, sim, selected, measured, warnings],
  );
  const rfEdges: Edge[] = useMemo(
    () =>
      edgesOf(nodes).map((e, i) => ({
        id: `${e.source}-${e.target}-${i}`,
        source: e.source,
        target: e.target,
        label: e.label,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: e.implicit ? { strokeDasharray: '4 4' } : undefined,
      })),
    [nodes],
  );

  if (!content || !artifact) return <p className="text-muted">Loading…</p>;

  const onNodesChange = (changes: NodeChange<Node<StepData>>[]) => {
    const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
    if (dims.length) setMeasured((m) => ({ ...m, ...Object.fromEntries(dims.map((c) => [(c as { id: string }).id, (c as { dimensions: { width: number; height: number } }).dimensions])) }));
    if (dims.length === changes.length) return;
    const moved = applyNodeChanges(changes, rfNodes);
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
    let next: LiveNode[] = nodes.map((n) => ({ ...n, position: moved.find((m) => m.id === n.id)?.position ?? n.position }));
    if (removed.size) next = materialize(next).filter((n) => !removed.has(n.id)).map((n) => ({ ...n, next: n.next?.filter((e) => !removed.has(e.to)) }));
    const dragEnd = changes.some((c) => c.type === 'position' && c.dragging === false);
    if (removed.size || dragEnd) save({ ...content, nodes: next });
    else setContent({ ...content, nodes: next });
  };
  const onConnect = (c: Connection) => {
    const all = materialize(nodes);
    save({ ...content, nodes: all.map((n) => (n.id === c.source ? { ...n, next: [...(n.next ?? []), { to: c.target }] } : n)) });
  };
  const addNode = (kind: NodeKind) => {
    const all = materialize(nodes);
    const anchor = all.find((n) => n.id === selected) ?? all[all.length - 1];
    const nid = `n${Date.now().toString(36).slice(-4)}`;
    // Insert after the anchor: it continues to the new step, which takes over where it went.
    // Steps with several outcomes (branch, split, waits) get the new step as an extra edge.
    const single = anchor && anchor.kind !== 'exit' && (anchor.next?.length ?? 0) <= 1 && !EDGE_LABELS[anchor.kind] && anchor.kind !== 'split' && anchor.kind !== 'aiDecide';
    const node: LiveNode = {
      id: nid,
      kind,
      label: kindMeta[kind].label,
      config: structuredClone(DEFAULTS[kind] ?? {}),
      next: single && kind !== 'exit' ? (anchor.next ?? []) : [],
      position: anchor?.position ? { x: anchor.position.x, y: anchor.position.y + 150 } : { x: 0, y: 0 },
    };
    const shifted = all.map((n) =>
      single && n.position && anchor.position && n.id !== anchor.id && n.position.y > anchor.position.y ? { ...n, position: { ...n.position, y: n.position.y + 150 } } : n,
    );
    save({
      ...content,
      nodes: [
        ...shifted.map((n) => (n.id === anchor?.id && n.kind !== 'exit' ? { ...n, next: single ? [{ to: nid }] : [...(n.next ?? []), { to: nid }] } : n)),
        node,
      ],
    });
    setSelected(nid);
  };
  const update = (nid: string, patch: Partial<LiveNode>) => save({ ...content, nodes: nodes.map((n) => (n.id === nid ? { ...n, ...patch } : n)) });

  const sel = nodes.find((n) => n.id === selected);
  const latest = artifact.version;

  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[560px] flex-col overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button variant="ghost" onClick={onBack} aria-label="Back to journeys">
          <ArrowLeft size={16} />
        </Button>
        <div className="mr-2 min-w-0">
          <div className="truncate text-[15px] font-semibold">{artifact.name}</div>
          <div className="text-[11px] text-muted">
            v{latest.number} {latest.state.replace('_', ' ')}
            {artifact.publishedVersion ? ` · live v${artifact.publishedVersion}` : ''} {status && `· ${status}`}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {stats && (
            <Button variant={showStats ? 'secondary' : 'ghost'} onClick={() => setShowStats(!showStats)}>
              <BarChart3 size={14} /> Stats
            </Button>
          )}
          <select className={cx(inputBase, 'w-[150px]')} value={simProfile} onChange={(e) => setSimProfile(e.target.value)} aria-label="Person to simulate">
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id.slice(0, 12)}… {p.known ? '(known)' : ''}
              </option>
            ))}
          </select>
          <Button
            onClick={async () => {
              try {
                setSelected(null);
                setSim(await api.call('journeys.simulate', { artifactId: id, ...(simProfile ? { profileId: simProfile } : {}) }));
              } catch (e) {
                onError(errText(e));
              }
            }}
          >
            <Play size={14} /> Simulate
          </Button>
          <Button
            variant="primary"
            disabled={latest.state !== 'draft'}
            onClick={async () => {
              try {
                const r = await api.call('artifacts.requestPublish', { artifactId: id, note: 'Published from the journey canvas' });
                setStatus(r.status === 'published' ? `Published v${r.version}` : 'Sent for approval');
                await reload();
              } catch (e) {
                onError(errText(e));
              }
            }}
          >
            <Send size={14} /> Publish
          </Button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="border-b border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-warn">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={13} /> {warnings.length} step{warnings.length === 1 ? '' : 's'} need{warnings.length === 1 ? 's' : ''} attention before publishing
          </div>
          <ul className="mt-1 space-y-0.5">
            {warnings.slice(0, 6).map((w, i) => (
              <li key={`${w.nodeId ?? 'journey'}-${w.path}-${i}`} className="flex flex-wrap gap-x-1.5">
                <span className="font-medium">{nodes.find((n) => n.id === w.nodeId)?.label ?? 'Journey'}</span>
                <span className="min-w-0 break-words opacity-90">{w.message}</span>
              </li>
            ))}
            {warnings.length > 6 && <li className="opacity-90">…and {warnings.length - 6} more</li>}
          </ul>
          <p className="mt-1 opacity-90">Saving still works: publishing waits until these are filled in.</p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface p-2 md:w-[160px] md:flex-col md:border-b-0 md:border-r">
          {PALETTE.map((k) => {
            const m = kindMeta[k];
            return (
              <button key={k} onClick={() => addNode(k)} className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium hover:bg-surface-2" title={`Add ${m.label} after the selected step`}>
                <m.icon size={14} /> {m.label}
              </button>
            );
          })}
        </div>
        <div className="relative min-h-[360px] flex-1">
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
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </div>
        <div className="shrink-0 overflow-y-auto border-t border-line bg-surface md:w-[300px] md:border-l md:border-t-0">
          {sim ? (
            <div className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="eyebrow">Simulation · virtual clock</div>
                  <div className="text-[13px] font-semibold">
                    {sim.outcome}
                    {sim.converted ? ' · converted' : ''}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => setSim(null)}>
                  Close
                </Button>
              </div>
              <ol className="space-y-2">
                {sim.steps.map((s, i) => (
                  <li key={i} className="rounded-md border border-line p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold">{s.label}</span>
                      <span className="font-mono text-[11px] text-accent">{s.after}</span>
                    </div>
                    {s.detail && <div className={cx('mt-0.5 break-all text-[12px]', s.detail.startsWith('would not send') ? 'text-bad' : 'text-muted')}>{s.detail}</div>}
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[11px] text-muted">Dry run: nothing is sent. Agents use the same simulation (journeys.simulate).</p>
            </div>
          ) : sel ? (
            <Inspector key={sel.id} node={sel} onChange={(patch) => update(sel.id, patch)} onDelete={() => onNodesChange([{ type: 'remove', id: sel.id }])} />
          ) : (
            <div className="space-y-3 p-4 text-[13px] text-muted">
              <div className="eyebrow">Inspector</div>
              <p>Select a step to edit it, drag between handles to connect steps, or add one from the palette. Dashed edges mean "continue with the next step".</p>
              {stats && (
                <div className="num grid grid-cols-2 gap-1.5 rounded-md border border-line p-3 text-[12px]">
                  <span>Waiting now</span>
                  <b className="text-right text-fg">{stats.now.waiting}</b>
                  <span>Completed</span>
                  <b className="text-right text-fg">{stats.now.completed + stats.now.exited}</b>
                  <span>Converted</span>
                  <b className="text-right text-good">{stats.now.converted}</b>
                  <span>Failed</span>
                  <b className="text-right text-bad">{stats.now.failed}</b>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Inspector({ node, onChange, onDelete }: { node: LiveNode; onChange: (p: Partial<LiveNode>) => void; onDelete: () => void }) {
  const [json, setJson] = useState(JSON.stringify(node.config, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="eyebrow">{kindMeta[node.kind].label}</div>
        <Button variant="ghost" onClick={onDelete} aria-label="Delete step">
          <Trash2 size={14} />
        </Button>
      </div>
      <label className="block">
        <span className="mb-1 block text-[12px] font-medium text-muted">Label</span>
        <input className={inputCls} value={node.label} onChange={(e) => onChange({ label: e.target.value })} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] font-medium text-muted">Settings (JSON)</span>
        <textarea
          className={cx(inputCls, 'h-40 font-mono text-[12px]', bad && 'border-bad')}
          value={json}
          spellCheck={false}
          onChange={(e) => {
            setJson(e.target.value);
            try {
              onChange({ config: JSON.parse(e.target.value) });
              setBad(false);
            } catch {
              setBad(true);
            }
          }}
        />
      </label>
      {EDGE_LABELS[node.kind] && <p className="text-[12px] text-muted">Outgoing edges, in order: {EDGE_LABELS[node.kind]!.join(', ')}.</p>}
      {(node.kind === 'email' || node.kind === 'sms' || node.kind === 'push') && <p className="rounded-md bg-surface-2 p-2.5 text-[12px] text-muted">The send gateway checks the template's purpose, consent, objections and suppressions before every send.</p>}
    </div>
  );
}
