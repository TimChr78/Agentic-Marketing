import { Bell, Bot, Clock, GitBranch, type LucideIcon, Mail, MessageSquare, Hourglass, LogOut, Pencil, Shuffle, Sparkles, Target, Variable, Webhook, Zap, Plug } from 'lucide-react';
import { durationText } from '../previews/ConditionView';

// The journey model shared by the builder and the read-only graph: node kinds, their category
// (colour), default settings and edge labels, matching packages/artifacts journey schema.

export type NodeKind =
  | 'trigger'
  | 'wait'
  | 'waitEvent'
  | 'branch'
  | 'split'
  | 'email'
  | 'sms'
  | 'push'
  | 'webhook'
  | 'action'
  | 'transform'
  | 'updateProfile'
  | 'aiDecide'
  | 'aiGenerate'
  | 'goal'
  | 'exit';

export interface JNode {
  id: string;
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;
  next?: { to: string; label?: string }[];
  position?: { x: number; y: number };
}
export interface JourneyContent {
  purpose: string;
  goal?: string;
  nodes: JNode[];
}

/** Categories (DESIGN.md → Journey categories): the only place the UI uses a categorical palette. */
export type Category = 'trigger' | 'message' | 'wait' | 'logic' | 'ai' | 'action' | 'exit';
export const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'trigger', label: 'Trigger' },
  { key: 'message', label: 'Message' },
  { key: 'wait', label: 'Wait' },
  { key: 'logic', label: 'Branch and goal' },
  { key: 'ai', label: 'AI' },
  { key: 'action', label: 'Webhook and action' },
  { key: 'exit', label: 'Exit' },
];

export const KINDS: Record<NodeKind, { label: string; category: Category; icon: LucideIcon; hint: string }> = {
  trigger: { label: 'Trigger', category: 'trigger', icon: Zap, hint: 'Who enters, and when' },
  email: { label: 'E-mail', category: 'message', icon: Mail, hint: 'Send an e-mail template' },
  sms: { label: 'SMS', category: 'message', icon: MessageSquare, hint: 'Send an SMS template' },
  push: { label: 'Push', category: 'message', icon: Bell, hint: 'Send a push notification' },
  wait: { label: 'Wait', category: 'wait', icon: Clock, hint: 'Pause for a while' },
  waitEvent: { label: 'Wait for event', category: 'wait', icon: Hourglass, hint: 'Pause until an event or a timeout' },
  branch: { label: 'Branch', category: 'logic', icon: GitBranch, hint: 'Yes or no on a condition' },
  split: { label: 'Split', category: 'logic', icon: Shuffle, hint: 'Random split by weight' },
  goal: { label: 'Goal', category: 'logic', icon: Target, hint: 'Count a conversion' },
  aiDecide: { label: 'AI decision', category: 'ai', icon: Bot, hint: 'A prompt picks the path' },
  aiGenerate: { label: 'AI content', category: 'ai', icon: Sparkles, hint: 'A prompt writes content slots' },
  webhook: { label: 'Webhook', category: 'action', icon: Webhook, hint: 'Post to a webhook endpoint' },
  action: { label: 'Action', category: 'action', icon: Plug, hint: 'Run a connection action' },
  updateProfile: { label: 'Update profile', category: 'action', icon: Pencil, hint: 'Set a trait' },
  transform: { label: 'Transform', category: 'action', icon: Variable, hint: 'Compute a variable' },
  exit: { label: 'Exit', category: 'exit', icon: LogOut, hint: 'Leave the journey' },
};
export const PALETTE_ORDER: NodeKind[] = ['trigger', 'email', 'sms', 'push', 'wait', 'waitEvent', 'branch', 'split', 'goal', 'aiDecide', 'aiGenerate', 'webhook', 'action', 'updateProfile', 'transform', 'exit'];

export const DEFAULTS: Record<NodeKind, Record<string, unknown>> = {
  trigger: { event: 'Signed Up', reentry: 'once' },
  wait: { duration: 'P1D' },
  waitEvent: { event: 'Order Completed', timeout: 'P2D' },
  goal: { event: 'Order Completed', within: 'P14D' },
  branch: { condition: { trait: 'city', op: 'eq', value: '' } },
  split: { weights: [50, 50] },
  email: { template: '' },
  sms: { template: '' },
  push: { template: '' },
  updateProfile: { trait: 'lifecycle', value: 'engaged' },
  aiDecide: { prompt: '', options: ['a', 'b'], fallback: 'a', timeout: 'PT5M' },
  aiGenerate: { prompt: '', timeout: 'PT5M' },
  webhook: { endpoint: '' },
  action: { connection: '', action: 'postMessage', input: {}, timeout: 'PT10M' },
  transform: { set: 'total', expression: '' },
  exit: {},
};

/** Fixed outgoing edges for kinds with a meaning per edge. */
export const EDGE_LABELS: Partial<Record<NodeKind, string[]>> = {
  branch: ['yes', 'no'],
  waitEvent: ['matched', 'timeout'],
  goal: ['converted', 'timeout'],
  action: ['ok', 'error'],
};
/** How many outgoing edges a kind can have. */
export function maxEdges(n: JNode): number {
  if (n.kind === 'exit') return 0;
  if (EDGE_LABELS[n.kind]) return 2;
  if (n.kind === 'split') return Math.max(2, ((n.config.weights as unknown[]) ?? []).length);
  if (n.kind === 'aiDecide') return Math.max(2, ((n.config.options as unknown[]) ?? []).length);
  return 1;
}

export function edgeLabel(n: JNode, index: number): string | undefined {
  const explicit = n.next?.[index]?.label;
  if (explicit) return explicit;
  if (EDGE_LABELS[n.kind]) return EDGE_LABELS[n.kind]![index];
  if (n.kind === 'split') return `${String.fromCharCode(65 + index)} · ${((n.config.weights as number[]) ?? [])[index] ?? 0}%`;
  if (n.kind === 'aiDecide') return ((n.config.options as string[]) ?? [])[index];
  return undefined;
}

export interface JEdge {
  source: string;
  target: string;
  index: number;
  label?: string;
}
/** Edges as stored (`next`), plus the implicit "continue with the following node" of the schema. */
export function edgesOf(nodes: JNode[]): JEdge[] {
  return nodes.flatMap((n, i): JEdge[] => {
    if (n.next) return n.next.map((e, k) => ({ source: n.id, target: e.to, index: k, label: edgeLabel(n, k) }));
    const following = nodes[i + 1];
    return n.kind !== 'exit' && following ? [{ source: n.id, target: following.id, index: 0, label: edgeLabel(n, 0) }] : [];
  });
}
/** Makes every edge explicit, so the canvas and the stored JSON agree; keeps labels. */
export function materialize(nodes: JNode[]): JNode[] {
  const edges = edgesOf(nodes);
  return nodes.map((n) => ({ ...n, next: edges.filter((e) => e.source === n.id).map((e) => (n.next?.[e.index]?.label ? { to: e.target, label: n.next[e.index]!.label } : { to: e.target })) }));
}

export function newNodeId(nodes: JNode[]): string {
  const used = new Set(nodes.map((n) => n.id));
  let i = nodes.length + 1;
  while (used.has(`n${i}`)) i++;
  return `n${i}`;
}

const short = (v: unknown) => (typeof v === 'string' && v ? v : '');
/** One line under a node's label, from its settings. `names` resolves artifact ids. */
export function summary(n: JNode, names: (id: string) => string | undefined = () => undefined): string {
  const c = n.config as Record<string, any>;
  const ref = (id: unknown, empty: string) => (short(id) ? (names(String(id)) ?? `${String(id).slice(0, 12)}…`) : empty);
  switch (n.kind) {
    case 'trigger':
      return c.segment ? `Enters segment ${ref(c.segment, '')}` : c.event ? `On “${c.event}”` : 'Choose an event or segment';
    case 'wait':
      return c.duration ? durationText(String(c.duration)) : 'Set a duration';
    case 'waitEvent':
      return c.event ? `Until “${c.event}”, at most ${durationText(String(c.timeout ?? ''))}` : 'Choose an event';
    case 'goal':
      return c.event ? `“${c.event}” within ${durationText(String(c.within ?? ''))}` : 'Choose an event';
    case 'branch':
      return c.segment ? `In ${ref(c.segment, '')}?` : c.condition ? 'Condition' : 'Set a condition';
    case 'split':
      return (c.weights ?? []).map((w: number, i: number) => `${String.fromCharCode(65 + i)} ${w}%`).join(' · ');
    case 'email':
    case 'sms':
    case 'push':
      return ref(c.template, 'Choose a template');
    case 'updateProfile':
      return c.trait ? `${c.trait} = ${JSON.stringify(c.value)}` : 'Choose a trait';
    case 'webhook':
      return c.endpoint ? `To ${String(c.endpoint).slice(0, 12)}…` : 'Choose an endpoint';
    case 'action':
      return c.connection ? `${c.action}` : 'Choose a connection';
    case 'transform':
      return c.set ? `vars.${c.set}` : 'Set a variable';
    case 'aiDecide':
      return c.prompt ? `${ref(c.prompt, '')}: ${(c.options ?? []).join(' / ')}` : 'Choose a decide prompt';
    case 'aiGenerate':
      return ref(c.prompt, 'Choose a generate prompt');
    default:
      return '';
  }
}

