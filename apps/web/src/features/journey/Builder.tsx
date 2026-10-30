import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  BarChart3,
  Copy,
  Map as MapIcon,
  Maximize,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Settings2,
  ShieldCheck,
  Trash2,
  Undo2,
} from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../app/api';
import { useSession } from '../../app/session';
import { useResolvedTheme } from '../../app/theme';
import { useApi } from '../../app/useApi';
import {
  Button,
  Checkbox,
  ContextMenu,
  cx,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Menu,
  type MenuItem,
  Select,
  Tabs,
  Tag,
  useToast,
} from '../../ui';
import { referencedIds, useArtifactNames } from '../artifactCache';
import type { EditorProps } from '../artifacts/ArtifactDetailPage';
import { localWarnings, mergeWarnings } from './checks';
import { Inspector } from './Inspector';
import { Legend } from './Legend';
import { NODE_H, NODE_W, positionsOf } from './layout';
import { edgesOf, type JNode, type JourneyContent, KINDS, maxEdges, type NodeKind, PALETTE_ORDER, summary } from './model';
import { type NodeData, nodeTypes } from './NodeView';
import { addNode, connect, deleteNode, disconnect, duplicateNode, type EditResult, withPositions } from './ops';
import { DND_TYPE, Palette } from './Palette';
import { SimulatePanel } from './SimulatePanel';

type Sel = { kind: 'node'; id: string } | { kind: 'edge'; source: string; index: number } | null;
const edgeId = (source: string, index: number) => `${source}:${index}`;

// Builder chrome (panel visibility, live stats, minimap) is remembered per person on this device,
// like the theme: `am.journey.<user id>.<key>`.
const prefKey = (scope: string, key: string) => `am.journey.${scope}.${key}`;
function readPref<T>(scope: string, key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(prefKey(scope, key));
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writePref(scope: string, key: string, value: unknown) {
  try {
    localStorage.setItem(prefKey(scope, key), JSON.stringify(value));
  } catch {
    /* private mode or a full store: the preference is cosmetic */
  }
}

/** The journey builder (#33). Edits the same JSON agents edit; the detail page autosaves it. */
export function JourneyBuilder(p: EditorProps<JourneyContent>) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...p} />
    </ReactFlowProvider>
  );
}

function BuilderInner({ artifact, content, onChange, readOnly, warnings: serverWarnings }: EditorProps<JourneyContent>) {
  const theme = useResolvedTheme();
  const toast = useToast();
  const rf = useReactFlow();
  const { user } = useSession();
  const scope = user?.id ?? 'anon';
  const nodes = content.nodes ?? [];
  const [sel, setSel] = useState<Sel>(null);
  const [panel, setPanel] = useState<'inspect' | 'check' | 'simulate'>('inspect');
  const [path, setPath] = useState<string[]>([]);
  // The canvas gets the window's width (#114): both side panels can collapse, and full screen
  // hides the app chrome. All of it is remembered per person.
  const [paletteOpen, setPaletteOpen] = useState(() => readPref(scope, 'palette', true));
  const [inspectorOpen, setInspectorOpen] = useState(() => readPref(scope, 'inspector', true));
  const [showMinimap, setShowMinimap] = useState(() => readPref(scope, 'minimap', true));
  const [showStats, setShowStats] = useState(() => readPref(scope, 'stats', false));
  const [fullscreen, setFullscreen] = useState(false);
  const [canvasWide, setCanvasWide] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | 'separator')[] } | null>(null);
  const past = useRef<JNode[][]>([]);
  const future = useRef<JNode[][]>([]);
  const [, bump] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const names = useArtifactNames(referencedIds(nodes));

  const published = artifact.publishedVersion !== null && artifact.publishedVersion !== undefined;
  // #58: per-step passed/waiting for the live version, refreshed while shown.
  const stats = useApi(() => api.call('journeys.stats', { artifactId: artifact.id }), [artifact.id, artifact.publishedVersion], {
    skip: !showStats || !published,
  });
  const statData = showStats ? stats.data : undefined;
  useEffect(() => {
    if (!showStats || !published) return;
    const timer = setInterval(() => void stats.reload(), 30_000);
    return () => clearInterval(timer);
  }, [showStats, published, stats.reload]);

  const setPref = (key: string, value: boolean, set: (v: boolean) => void) => {
    set(value);
    writePref(scope, key, value);
  };

  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  useEffect(() => {
    const el = wrapper.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setCanvasWide((entry?.contentRect.width ?? 0) >= 900));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear undo history when switching artifact, which the body does not read
  useEffect(() => {
    past.current = [];
    future.current = [];
    bump((x) => x + 1);
  }, [artifact.id]);

  const warnings = useMemo(() => mergeWarnings(localWarnings(nodes), serverWarnings), [nodes, serverWarnings]);
  const warnCount = Object.values(warnings).reduce((n, w) => n + w.length, 0);

  const apply = useCallback(
    (next: JNode[]) => {
      past.current.push(nodes);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      onChange({ ...content, nodes: next });
      setPath([]);
    },
    [nodes, content, onChange],
  );
  const commit = useCallback(
    (r: EditResult) => {
      if (r.note) toast.info(r.note);
      if (r.nodes === nodes) return;
      apply(r.nodes);
      if (r.select) setSel({ kind: 'node', id: r.select });
    },
    [nodes, apply, toast],
  );
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(nodes);
    onChange({ ...content, nodes: prev });
    bump((x) => x + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(nodes);
    onChange({ ...content, nodes: next });
    bump((x) => x + 1);
  };

  // React Flow nodes: derived from the JSON; drags move them locally and commit on drop.
  const positions = useMemo(() => positionsOf(nodes), [nodes]);
  const build = useCallback(
    (): Node[] =>
      nodes.map((n) => ({
        id: n.id,
        type: 'step',
        position: positions[n.id]!,
        selected: sel?.kind === 'node' && sel.id === n.id,
        draggable: !readOnly,
        ariaLabel: `${KINDS[n.kind].label}: ${n.label}. ${summary(n, names)}${warnings[n.id]?.length ? `. Incomplete: ${warnings[n.id]!.join(' ')}` : ''}`,
        data: {
          node: n,
          summary: summary(n, names),
          warnings: warnings[n.id] ?? [],
          stats: statData ? { reached: statData.reached[n.id] ?? 0, waiting: statData.waitingAt[n.id] ?? 0 } : undefined,
          readOnly,
          highlight: path.includes(n.id),
        } satisfies NodeData,
      })),
    [nodes, positions, sel, readOnly, names, warnings, path, statData],
  );
  const [rfNodes, setRfNodes] = useState<Node[]>(build);
  useEffect(() => setRfNodes(build()), [build]);

  const rfEdges = useMemo<Edge[]>(
    () =>
      edgesOf(nodes).map((e) => {
        const selected = sel?.kind === 'edge' && sel.source === e.source && sel.index === e.index;
        return {
          id: edgeId(e.source, e.index),
          source: e.source,
          sourceHandle: `out-${e.index}`,
          target: e.target,
          label: e.label,
          selected,
          focusable: true,
          ariaLabel: `Connection from ${nodes.find((n) => n.id === e.source)?.label}${e.label ? ` (${e.label})` : ''} to ${nodes.find((n) => n.id === e.target)?.label}`,
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: path.includes(e.source) && path.includes(e.target),
          labelBgStyle: { fill: 'var(--surface)' },
          labelStyle: { fill: 'var(--fg-2)', fontSize: 11 },
          style: selected ? { stroke: 'var(--accent)', strokeWidth: 2 } : undefined,
        };
      }),
    [nodes, sel, path],
  );

  const selectedNode = sel?.kind === 'node' ? nodes.find((n) => n.id === sel.id) : undefined;

  const removeSelection = () => {
    if (readOnly || !sel) return;
    if (sel.kind === 'node') commit(deleteNode(nodes, sel.id));
    else commit(disconnect(nodes, sel.source, sel.index));
    setSel(null);
  };

  const addAfterSelection = (kind: NodeKind) => {
    if (readOnly) return;
    const from =
      selectedNode && selectedNode.kind !== 'exit' && (selectedNode.next?.length ?? 0) < maxEdges(selectedNode) ? selectedNode : undefined;
    let position: { x: number; y: number };
    if (from) {
      const at = positions[from.id]!;
      const i = from.next?.length ?? 0;
      position = { x: at.x + (maxEdges(from) > 1 ? (i - (maxEdges(from) - 1) / 2) * (NODE_W + 40) : 0), y: at.y + NODE_H + 72 };
    } else {
      const lowest = Math.max(0, ...Object.values(positions).map((p) => p.y));
      position = { x: 0, y: nodes.length ? lowest + NODE_H + 72 : 0 };
    }
    commit(addNode(nodes, kind, position, from ? { source: from.id, index: from.next?.length ?? 0 } : undefined));
    requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 200 }));
  };

  const nodeMenu = (n: JNode): (MenuItem | 'separator')[] => [
    { label: 'Edit settings', icon: <Settings2 />, onSelect: () => (setSel({ kind: 'node', id: n.id }), setPanel('inspect')) },
    ...(readOnly
      ? []
      : ([
          {
            label: 'Duplicate',
            icon: <Copy />,
            hint: 'Ctrl D',
            disabled: n.kind === 'trigger',
            onSelect: () => commit(duplicateNode(nodes, n.id)),
          },
          'separator',
          {
            label: 'Delete step',
            icon: <Trash2 />,
            hint: 'Del',
            destructive: true,
            onSelect: () => (commit(deleteNode(nodes, n.id)), setSel(null)),
          },
        ] as (MenuItem | 'separator')[])),
  ];

  // Shortcuts work while focus is in the builder, or nowhere in particular (after a deleted step
  // took the focus with it).
  const keyRef = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const a = document.activeElement;
      if (a && a !== document.body && !root.current?.contains(a)) return;
      keyRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable=true]')) return;
    const mod = e.metaKey || e.ctrlKey;
    // A focused edge (Tab reaches edges too) acts like a selected one.
    const focusedEdge = (t.closest('.react-flow__edge') as HTMLElement | null)?.dataset.id;
    if (focusedEdge && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      const [source, index] = focusedEdge.split(':');
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!readOnly) commit(disconnect(nodes, source!, Number(index)));
        return;
      }
      const r = t.getBoundingClientRect();
      if (!readOnly)
        setMenu({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          items: [
            {
              label: 'Delete connection',
              icon: <Trash2 />,
              hint: 'Del',
              destructive: true,
              onSelect: () => (commit(disconnect(nodes, source!, Number(index))), setSel(null)),
            },
          ],
        });
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault();
      removeSelection();
    } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === 'd' && selectedNode) {
      e.preventDefault();
      commit(duplicateNode(nodes, selectedNode.id));
    } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && selectedNode) {
      e.preventDefault();
      const el = wrapper.current?.querySelector(`[data-id="${selectedNode.id}"]`)?.getBoundingClientRect();
      setMenu({ x: el ? el.left + 24 : 200, y: el ? el.bottom : 200, items: nodeMenu(selectedNode) });
    } else if (!mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setFullscreen((v) => !v);
    } else if (e.key === 'Escape') {
      if (fullscreen) setFullscreen(false);
      else setSel(null);
    }
  };

  keyRef.current = (e) => onKeyDown(e as unknown as KeyboardEvent);

  const gridCols = paletteOpen
    ? inspectorOpen
      ? 'lg:grid-cols-[156px_minmax(0,1fr)_224px]'
      : 'lg:grid-cols-[156px_minmax(0,1fr)]'
    : inspectorOpen
      ? 'lg:grid-cols-[minmax(0,1fr)_224px]'
      : 'lg:grid-cols-[minmax(0,1fr)]';

  return (
    <div
      ref={root}
      className={cx(
        'grid gap-0 overflow-hidden border border-line bg-surface',
        fullscreen
          ? 'fixed inset-0 z-50 h-dvh max-h-dvh rounded-none'
          : // Full-bleed: cancel the shell's page padding so the canvas uses the whole window (#114).
            '-mx-4 rounded-lg sm:-mx-6 lg:-mx-8 lg:h-[calc(100dvh-232px)] lg:min-h-[560px]',
        gridCols,
      )}
    >
      {paletteOpen && (
        <aside className="hidden border-r border-line lg:block">
          {!readOnly ? (
            <Palette onAdd={addAfterSelection} />
          ) : (
            <p className="p-3 text-[12px] text-muted">Your role can view this journey but not edit it.</p>
          )}
        </aside>
      )}

      <div className="flex min-h-[480px] min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
          <IconButton
            className="hidden lg:inline-flex"
            label={paletteOpen ? 'Hide step palette' : 'Show step palette'}
            aria-pressed={paletteOpen}
            icon={<PanelLeft size={15} />}
            onClick={() => setPref('palette', !paletteOpen, setPaletteOpen)}
          />
          {!readOnly && (
            <>
              <div className="lg:hidden">
                <Menu
                  label="Add step"
                  align="start"
                  items={PALETTE_ORDER.map((k) => ({
                    label: KINDS[k].label,
                    icon: (() => {
                      const I = KINDS[k].icon;
                      return <I style={{ color: `var(--cat-${KINDS[k].category})` }} />;
                    })(),
                    onSelect: () => addAfterSelection(k),
                  }))}
                  trigger={(t) => (
                    <Button {...t} size="sm" icon={<Plus size={14} />}>
                      Add step
                    </Button>
                  )}
                />
              </div>
              <IconButton label="Undo (Ctrl Z)" icon={<Undo2 size={15} />} onClick={undo} disabled={!past.current.length} />
              <IconButton label="Redo (Ctrl Shift Z)" icon={<Redo2 size={15} />} onClick={redo} disabled={!future.current.length} />
              <IconButton label="Delete selected (Del)" icon={<Trash2 size={15} />} onClick={removeSelection} disabled={!sel} />
            </>
          )}
          <IconButton label="Fit to screen" icon={<Maximize size={15} />} onClick={() => rf.fitView({ padding: 0.2, duration: 200 })} />
          <IconButton
            className="hidden md:inline-flex"
            label={showMinimap ? 'Hide minimap' : 'Show minimap'}
            aria-pressed={showMinimap}
            icon={<MapIcon size={15} />}
            onClick={() => setPref('minimap', !showMinimap, setShowMinimap)}
          />
          <IconButton
            label={fullscreen ? 'Leave full screen (Esc)' : 'Full screen (F)'}
            aria-pressed={fullscreen}
            icon={fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            onClick={() => setFullscreen((v) => !v)}
          />
          {published && (
            <Button
              size="sm"
              variant={showStats ? 'secondary' : 'ghost'}
              icon={<BarChart3 size={14} />}
              aria-pressed={showStats}
              onClick={() => setPref('stats', !showStats, setShowStats)}
            >
              {showStats ? 'Hide stats' : 'Show stats'}
            </Button>
          )}
          {content.controlGroup && (
            <Tag icon={<ShieldCheck size={12} aria-hidden />} className="hidden sm:inline-flex">
              Control {content.controlGroup.percent}%
            </Tag>
          )}
          <IconButton
            className="ml-auto"
            label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
            aria-pressed={inspectorOpen}
            icon={<PanelRight size={15} />}
            onClick={() => setPref('inspector', !inspectorOpen, setInspectorOpen)}
          />
          <div className="hidden xl:block">
            <Legend className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-2" />
          </div>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: canvas drop target; adding a step is also available from the palette buttons */}
        <div
          ref={wrapper}
          className="relative min-h-0 flex-1 bg-surface-2"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DND_TYPE)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(e) => {
            const kind = e.dataTransfer.getData(DND_TYPE) as NodeKind;
            if (!kind || readOnly) return;
            e.preventDefault();
            const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
            commit(addNode(nodes, kind, { x: at.x - NODE_W / 2, y: at.y - 24 }));
          }}
        >
          {nodes.length === 0 ? (
            <EmptyState
              title="Start with a trigger"
              action={
                !readOnly && (
                  <Button variant="primary" onClick={() => addAfterSelection('trigger')}>
                    Add a trigger
                  </Button>
                )
              }
            >
              Drag steps from the left, or press them, to build the journey.
            </EmptyState>
          ) : (
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              colorMode={theme}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.2}
              nodeDragThreshold={5}
              proOptions={{ hideAttribution: true }}
              deleteKeyCode={null}
              nodesConnectable={!readOnly}
              onNodesChange={(changes: NodeChange[]) =>
                setRfNodes((ns) =>
                  applyNodeChanges(
                    changes.filter((c) => c.type !== 'select' && c.type !== 'remove'),
                    ns,
                  ),
                )
              }
              onNodeDragStop={() => commit({ nodes: withPositions(nodes, Object.fromEntries(rfNodes.map((n) => [n.id, n.position]))) })}
              onNodeClick={(_, n) => {
                setSel({ kind: 'node', id: n.id });
                setPanel('inspect');
              }}
              onEdgeClick={(_, e) => {
                const [source, index] = e.id.split(':');
                setSel({ kind: 'edge', source: source!, index: Number(index) });
              }}
              onPaneClick={() => setSel(null)}
              onConnect={(c: Connection) => commit(connect(nodes, c.source, Number(c.sourceHandle?.split('-')[1] ?? 0), c.target))}
              isValidConnection={(c) => {
                const src = nodes.find((n) => n.id === c.source);
                const i = Number(c.sourceHandle?.split('-')[1] ?? 0);
                return (
                  !!src && c.source !== c.target && i <= (src.next?.length ?? 0) && nodes.find((n) => n.id === c.target)?.kind !== 'trigger'
                );
              }}
              onNodeContextMenu={(e, n) => {
                e.preventDefault();
                setSel({ kind: 'node', id: n.id });
                const jn = nodes.find((x) => x.id === n.id);
                if (jn) setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(jn) });
              }}
              onEdgeContextMenu={(e, edge) => {
                e.preventDefault();
                const [source, index] = edge.id.split(':');
                setSel({ kind: 'edge', source: source!, index: Number(index) });
                if (!readOnly)
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      {
                        label: 'Delete connection',
                        icon: <Trash2 />,
                        hint: 'Del',
                        destructive: true,
                        onSelect: () => (commit(disconnect(nodes, source!, Number(index))), setSel(null)),
                      },
                    ],
                  });
              }}
              aria-label={`Journey canvas, ${nodes.length} steps. Tab to a step, Enter to select it, Delete removes the selection, Shift F10 opens its menu.`}
            >
              <Background gap={16} size={1} />
              <Controls showInteractive={false} position="bottom-left" />
              {showMinimap && canvasWide && (
                <MiniMap
                  pannable
                  zoomable
                  className="!hidden md:!block"
                  style={{ width: 150, height: 96 }}
                  nodeColor={(n) => `var(--cat-${KINDS[(n.data as NodeData).node.kind].category})`}
                />
              )}
            </ReactFlow>
          )}
        </div>
        <p className="border-t border-line px-3 py-1.5 text-[11px] text-muted">
          <Kbd>Del</Kbd> delete · <Kbd>Ctrl Z</Kbd> undo · <Kbd>Ctrl D</Kbd> duplicate · right-click or <Kbd>Shift F10</Kbd> for more · drag
          from a dot to connect
        </p>
      </div>

      {inspectorOpen && (
        <aside className={cx('min-h-0 border-t border-line lg:border-t-0 lg:border-l', 'flex flex-col')}>
          <div className="px-3 pt-1">
            <Tabs
              label="Panel"
              value={panel}
              onChange={setPanel}
              compact
              items={[
                { key: 'inspect', label: selectedNode ? 'Step' : 'Journey' },
                { key: 'check', label: 'Check', count: warnCount },
                { key: 'simulate', label: 'Simulate' },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === 'inspect' &&
              (selectedNode ? (
                <Inspector
                  key={selectedNode.id}
                  node={selectedNode}
                  nodes={nodes}
                  warnings={warnings[selectedNode.id] ?? []}
                  readOnly={readOnly}
                  onChange={(n) => commit({ nodes: nodes.map((x) => (x.id === n.id ? n : x)) })}
                  onConnect={(i, target) =>
                    commit(target ? connect(nodes, selectedNode.id, i, target) : disconnect(nodes, selectedNode.id, i))
                  }
                  onDelete={() => (commit(deleteNode(nodes, selectedNode.id)), setSel(null))}
                  onDuplicate={() => commit(duplicateNode(nodes, selectedNode.id))}
                />
              ) : (
                <JourneySettings content={content} onChange={onChange} readOnly={readOnly} artifactId={artifact.id} published={published} />
              ))}
            {panel === 'check' && (
              <CheckList
                nodes={nodes}
                warnings={warnings}
                onSelect={(id) => (
                  setSel({ kind: 'node', id }), setPanel('inspect'), rf.fitView({ nodes: [{ id }], duration: 250, maxZoom: 1.2 })
                )}
              />
            )}
            {panel === 'simulate' && (
              <SimulatePanel
                artifactId={artifact.id}
                version={artifact.version.number}
                nodes={nodes}
                dirty={JSON.stringify(content) !== JSON.stringify(artifact.version.content)}
                onPath={setPath}
                onSelect={(id) => setSel({ kind: 'node', id })}
              />
            )}
          </div>
        </aside>
      )}
      <ContextMenu at={menu} items={menu?.items ?? []} onClose={() => setMenu(null)} label="Step actions" />
    </div>
  );
}

function CheckList({ nodes, warnings, onSelect }: { nodes: JNode[]; warnings: Record<string, string[]>; onSelect: (id: string) => void }) {
  const items = nodes.filter((n) => warnings[n.id]?.length);
  if (!items.length)
    return (
      <EmptyState compact title="Ready to publish">
        Every step has what it needs. Simulate it, then submit it for review.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-line">
      {items.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={() => onSelect(n.id)} className="w-full px-4 py-3 text-left hover:bg-surface-2">
            <span className="text-[13px] font-medium">{n.label}</span> <span className="text-[12px] text-muted">{KINDS[n.kind].label}</span>
            <ul className="mt-1 list-disc pl-4 text-[12px] text-warn">
              {warnings[n.id]!.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </button>
        </li>
      ))}
    </ul>
  );
}

function JourneySettings({
  content,
  onChange,
  readOnly,
  artifactId,
  published,
}: {
  content: JourneyContent;
  onChange: (c: JourneyContent) => void;
  readOnly: boolean;
  artifactId: string;
  published: boolean;
}) {
  return <JourneyMeta content={content} onChange={onChange} readOnly={readOnly} artifactId={artifactId} published={published} />;
}

function JourneyMeta({
  content,
  onChange,
  readOnly,
  artifactId,
  published,
}: {
  content: JourneyContent;
  onChange: (c: JourneyContent) => void;
  readOnly: boolean;
  artifactId: string;
  published: boolean;
}) {
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  // A rough expected control size from the people already in the journey, not a forecast.
  const stats = useApi(() => api.call('journeys.stats', { artifactId }), [artifactId], { skip: !published });
  const total = stats.data
    ? stats.data.now.ready + stats.data.now.waiting + stats.data.now.completed + stats.data.now.exited + stats.data.now.failed
    : 0;
  const cg = content.controlGroup;
  const setCg = (patch: Partial<NonNullable<JourneyContent['controlGroup']>>) =>
    onChange({ ...content, controlGroup: { percent: 10, minSampleSize: 200, ...cg, ...patch } });
  return (
    <div className="space-y-4 p-4">
      <p className="text-[12px] text-muted">Select a step to edit it. These settings apply to the whole journey.</p>
      <Field label="Purpose" hint="Every message in the journey is sent under this purpose's consent rules.">
        <Select value={content.purpose} disabled={readOnly} onChange={(e) => onChange({ ...content, purpose: e.target.value })}>
          {!purposes.data?.purposes.some((p) => p.key === content.purpose) && <option value={content.purpose}>{content.purpose}</option>}
          {purposes.data?.purposes.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} ({p.key})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Goal" hint="What success looks like, for the team and for reports.">
        <Input
          value={content.goal ?? ''}
          readOnly={readOnly}
          maxLength={200}
          onChange={(e) => onChange({ ...content, goal: e.target.value || undefined })}
        />
      </Field>

      <div className="rounded-md border border-line p-3">
        <Checkbox
          label="Control group"
          hint="Hold back a share of entrants from every e-mail, SMS and push step, and still measure whether they reach the goal."
          checked={!!cg}
          disabled={readOnly}
          onChange={(e) => {
            if (e.target.checked) setCg({ percent: 10, minSampleSize: 200 });
            else onChange({ ...content, controlGroup: undefined });
          }}
        />
        {cg && (
          <div className="mt-3 space-y-3">
            <Field label="Share in control" hint="1–50%. Assigned once per person per journey scope.">
              <Input
                type="number"
                min={1}
                max={50}
                value={cg.percent}
                readOnly={readOnly}
                onChange={(e) => setCg({ percent: Math.max(1, Math.min(50, Math.round(Number(e.target.value) || 1))) })}
              />
            </Field>
            <Field label="Minimum sample size" hint="Both arms need this many people before a verdict, default 200.">
              <Input
                type="number"
                min={1}
                value={cg.minSampleSize ?? 200}
                readOnly={readOnly}
                onChange={(e) => setCg({ minSampleSize: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
              />
            </Field>
            <p className="text-[12px] text-muted">
              Control people still wait, branch and reach the goal; they just get no marketing messages. Their conversions show what would
              have happened without the journey. Read the result with <span className="font-mono">journeys.holdoutResult</span>.
            </p>
            {published && total > 0 && (
              <p className="text-[12px] text-fg-2">
                About <strong>{Math.round((total * cg.percent) / 100).toLocaleString()}</strong> of the {total.toLocaleString()} people in
                this journey so far would be control.
              </p>
            )}
            <Checkbox
              label="Start a new scope if the percentage changes"
              hint="Publishing a changed percentage after people were assigned is refused unless this is ticked. People keep their old arm."
              checked={!!cg.reset}
              disabled={readOnly}
              onChange={(e) => setCg({ reset: e.target.checked })}
            />
          </div>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-[12px] font-medium text-fg-2">Step colours</p>
        <Legend className="grid grid-cols-2 gap-1.5 text-[12px] text-fg-2" />
      </div>
    </div>
  );
}
