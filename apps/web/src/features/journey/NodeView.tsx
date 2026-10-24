import { Handle, type NodeProps, Position } from '@xyflow/react';
import { AlertTriangle } from 'lucide-react';
import { memo } from 'react';
import { cx } from '../../ui';
import { NODE_W } from './layout';
import { edgeLabel, type JNode, KINDS, maxEdges } from './model';

export interface NodeData extends Record<string, unknown> {
  node: JNode;
  summary: string;
  warnings: string[];
  /** People who passed it / are waiting there (journey stats). */
  stats?: { reached?: number; waiting?: number };
  readOnly?: boolean;
}

/** One journey step on the canvas: category colour on the left edge and icon, text label, warnings. */
export const NodeView = memo(function NodeView({ data, selected }: NodeProps) {
  const { node, summary, warnings, stats, readOnly } = data as NodeData;
  const meta = KINDS[node.kind];
  const Icon = meta.icon;
  const color = `var(--cat-${meta.category})`;
  const outs = maxEdges(node);
  return (
    <div
      className={cx(
        'relative rounded-lg border bg-surface text-left shadow-1 transition-shadow',
        selected ? 'border-accent ring-2 ring-accent/30' : warnings.length ? 'border-warn/60' : 'border-line-strong',
      )}
      style={{ width: NODE_W }}
    >
      <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-lg" style={{ background: color }} aria-hidden />
      {node.kind !== 'trigger' && <Handle type="target" position={Position.Top} className="!size-2.5 !border-2 !border-surface !bg-line-strong" isConnectable={!readOnly} />}
      <div className="flex items-start gap-2.5 py-2.5 pr-3 pl-3.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
          <Icon size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-fg">{node.label}</span>
          </div>
          <div className="truncate text-[11px] font-medium text-muted">{meta.label}</div>
          <div className="mt-0.5 truncate text-[12px] text-fg-2" title={summary}>
            {summary}
          </div>
        </div>
      </div>
      {(warnings.length > 0 || stats) && (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-1.5 text-[11px]">
          {warnings.length > 0 && (
            <span className="inline-flex items-center gap-1 font-medium text-warn" title={warnings.join('\n')}>
              <AlertTriangle size={12} aria-hidden /> Incomplete
            </span>
          )}
          {stats?.reached !== undefined && <span className="text-muted tabular-nums">{stats.reached.toLocaleString()} passed</span>}
          {stats?.waiting ? <span className="text-muted tabular-nums">{stats.waiting.toLocaleString()} waiting</span> : null}
        </div>
      )}
      {Array.from({ length: outs }, (_, i) => {
        const left = outs === 1 ? '50%' : `${((i + 1) / (outs + 1)) * 100}%`;
        const label = outs > 1 ? edgeLabel(node, i) : undefined;
        return (
          <Handle
            key={i}
            id={`out-${i}`}
            type="source"
            position={Position.Bottom}
            style={{ left }}
            className="!size-2.5 !border-2 !border-surface !bg-fg-2"
            isConnectable={!readOnly}
            title={label ? `Connect “${label}”` : 'Connect to the next step'}
          >
            {label && <span className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 text-[10px] whitespace-nowrap text-muted">{label}</span>}
          </Handle>
        );
      })}
    </div>
  );
});

export const nodeTypes = { step: NodeView };
