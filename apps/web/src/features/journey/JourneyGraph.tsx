import { Background, Controls, type Edge, MarkerType, type Node, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { useResolvedTheme } from '../../app/theme';
import { Legend } from './Legend';
import { positionsOf } from './layout';
import { edgesOf, type JNode, summary } from './model';
import { type NodeData, nodeTypes } from './NodeView';
import { countFor, countText, type JourneyCounts, withNodeCounts } from './report/counts';

/**
 * A read-only journey graph, e.g. in the approval drawer, the report or the builder preview.
 * It renders counts supplied by its host and never fetches anything itself (#507).
 */
export function JourneyGraph({
  nodes,
  warnings = {},
  names,
  height = 480,
  counts,
  countsLabel,
}: {
  nodes: JNode[];
  warnings?: Record<string, string[]>;
  names?: (id: string) => string | undefined;
  height?: number;
  /** Node counts from one shared journeys.stats read; a missing key stays unavailable. */
  counts?: JourneyCounts;
  countsLabel?: string;
}) {
  const theme = useResolvedTheme();
  const pos = useMemo(() => positionsOf(nodes), [nodes]);
  const flowNodes = useMemo<Node[]>(
    () =>
      withNodeCounts(
        nodes.map((n) => ({
          id: n.id,
          type: 'step',
          position: pos[n.id]!,
          data: { node: n, summary: summary(n, names), warnings: warnings[n.id] ?? [], readOnly: true } satisfies NodeData,
          draggable: false,
          connectable: false,
        })),
        counts,
        countsLabel,
      ),
    [nodes, pos, warnings, names, counts, countsLabel],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      edgesOf(nodes).map((e) => ({
        id: `${e.source}-${e.index}-${e.target}`,
        source: e.source,
        sourceHandle: `out-${e.index}`,
        target: e.target,
        label: e.label,
        markerEnd: { type: MarkerType.ArrowClosed },
        labelBgStyle: { fill: 'var(--surface)' },
        labelStyle: { fill: 'var(--fg-2)', fontSize: 11 },
      })),
    [nodes],
  );
  return (
    <div className="space-y-2">
      {counts && countsLabel && <p className="text-[11px] leading-4 text-muted">{countsLabel}</p>}
      {/* A section, not role="img": the read-only nodes and the zoom controls inside it are focusable. */}
      <section
        className="overflow-hidden rounded-md border border-line bg-surface-2"
        style={{ height }}
        aria-label={`Journey graph with ${nodes.length} steps; the list below describes it`}
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            colorMode={theme}
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
          >
            <Background gap={16} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </section>
      <Legend />
      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted hover:text-fg">Steps as a list</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          {nodes.map((n) => {
            const out = edgesOf(nodes).filter((e) => e.source === n.id);
            const nodeCounts = countFor(n.id, counts, countsLabel);
            return (
              <li key={n.id}>
                <span className="font-medium">{n.label}</span> <span className="text-muted">({n.kind})</span>: {summary(n, names)}
                {nodeCounts && <span className="text-muted"> · {countText(nodeCounts)}</span>}
                {out.length > 0 && (
                  <span className="text-muted">
                    {' '}
                    →{' '}
                    {out
                      .map((e) => `${e.label ? `${e.label}: ` : ''}${nodes.find((x) => x.id === e.target)?.label ?? e.target}`)
                      .join(', ')}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}
