import type { SegmentCondition } from '@agentic-marketing/artifacts';
import { type JourneyDefinition, journeyNodeConfigs } from '@agentic-marketing/artifacts';
import { durationSeconds } from '@agentic-marketing/segments';
import type { z } from 'zod';

// A journey artifact compiled for the interpreter: settings parsed per kind, edges resolved
// ("no next" means the following node), durations in milliseconds.

type Cfg<K extends keyof typeof journeyNodeConfigs> = z.output<(typeof journeyNodeConfigs)[K]>;

export type Node =
  | { id: string; label: string; kind: 'trigger'; cfg: Cfg<'trigger'>; next: string | null }
  | { id: string; label: string; kind: 'wait'; ms: number; next: string | null }
  | { id: string; label: string; kind: 'waitEvent' | 'goal'; event: string; ms: number; matched: string | null; timeout: string | null }
  | { id: string; label: string; kind: 'branch'; segment?: string; condition?: SegmentCondition; yes: string | null; no: string | null }
  | { id: string; label: string; kind: 'split'; weights: number[]; edges: string[] }
  | { id: string; label: string; kind: 'email'; template: string; next: string | null }
  | { id: string; label: string; kind: 'updateProfile'; trait: string; value: string | number | boolean | null; next: string | null }
  | { id: string; label: string; kind: 'aiDecide'; prompt: string; options: string[]; fallback: string; ms: number; edges: string[] }
  | { id: string; label: string; kind: 'aiGenerate'; prompt: string; ms: number; next: string | null }
  | { id: string; label: string; kind: 'webhook'; endpoint: string; data?: string; next: string | null }
  | {
      id: string;
      label: string;
      kind: 'action';
      connection: string;
      action: string;
      input: Record<string, unknown> | string;
      ms: number;
      ok: string | null;
      error: string | null;
    }
  | { id: string; label: string; kind: 'transform'; set: string; expression: string; next: string | null }
  | { id: string; label: string; kind: 'exit' };

export interface Graph {
  start: string;
  /** The journey's purpose; webhook steps need a lawful basis for it. */
  purpose: string;
  trigger: Cfg<'trigger'>;
  nodes: Map<string, Node>;
}

export const RUNNABLE = new Set(Object.keys(journeyNodeConfigs));

export function compile(def: JourneyDefinition): Graph {
  const nodes = new Map<string, Node>();
  let trigger: Cfg<'trigger'> | undefined;
  let start = '';
  def.nodes.forEach((n, i) => {
    const following = def.nodes[i + 1]?.id ?? null;
    const edge = (k: number) => n.next?.[k]?.to ?? (n.next?.length ? null : following);
    const base = { id: n.id, label: n.label };
    switch (n.kind) {
      case 'trigger':
        trigger = journeyNodeConfigs.trigger.parse(n.config);
        start = n.id;
        nodes.set(n.id, { ...base, kind: 'trigger', cfg: trigger, next: edge(0) });
        break;
      case 'wait':
        nodes.set(n.id, {
          ...base,
          kind: 'wait',
          ms: durationSeconds(journeyNodeConfigs.wait.parse(n.config).duration) * 1000,
          next: edge(0),
        });
        break;
      case 'waitEvent':
      case 'goal': {
        const c = n.kind === 'goal' ? journeyNodeConfigs.goal.parse(n.config) : journeyNodeConfigs.waitEvent.parse(n.config);
        const ms = durationSeconds('within' in c ? c.within : c.timeout) * 1000;
        // With one edge, both outcomes continue there.
        nodes.set(n.id, { ...base, kind: n.kind, event: c.event, ms, matched: edge(0), timeout: n.next?.[1]?.to ?? edge(0) });
        break;
      }
      case 'branch': {
        const c = journeyNodeConfigs.branch.parse(n.config);
        nodes.set(n.id, {
          ...base,
          kind: 'branch',
          segment: c.segment,
          condition: c.condition as SegmentCondition | undefined,
          yes: n.next?.[0]?.to ?? null,
          no: n.next?.[1]?.to ?? null,
        });
        break;
      }
      case 'split':
        nodes.set(n.id, {
          ...base,
          kind: 'split',
          weights: journeyNodeConfigs.split.parse(n.config).weights,
          edges: (n.next ?? []).map((e) => e.to),
        });
        break;
      case 'email':
        nodes.set(n.id, { ...base, kind: 'email', template: journeyNodeConfigs.email.parse(n.config).template, next: edge(0) });
        break;
      case 'updateProfile': {
        const c = journeyNodeConfigs.updateProfile.parse(n.config);
        nodes.set(n.id, { ...base, kind: 'updateProfile', trait: c.trait, value: c.value, next: edge(0) });
        break;
      }
      case 'aiDecide': {
        const c = journeyNodeConfigs.aiDecide.parse(n.config);
        nodes.set(n.id, {
          ...base,
          kind: 'aiDecide',
          prompt: c.prompt,
          options: c.options,
          fallback: c.fallback,
          ms: durationSeconds(c.timeout) * 1000,
          edges: (n.next ?? []).map((e) => e.to),
        });
        break;
      }
      case 'aiGenerate': {
        const c = journeyNodeConfigs.aiGenerate.parse(n.config);
        nodes.set(n.id, { ...base, kind: 'aiGenerate', prompt: c.prompt, ms: durationSeconds(c.timeout) * 1000, next: edge(0) });
        break;
      }
      case 'webhook': {
        const c = journeyNodeConfigs.webhook.parse(n.config);
        nodes.set(n.id, { ...base, kind: 'webhook', endpoint: c.endpoint, data: c.data, next: edge(0) });
        break;
      }
      case 'action': {
        const c = journeyNodeConfigs.action.parse(n.config);
        nodes.set(n.id, {
          ...base,
          kind: 'action',
          connection: c.connection,
          action: c.action,
          input: c.input,
          ms: durationSeconds(c.timeout) * 1000,
          // With one edge, both outcomes continue there.
          ok: edge(0),
          error: n.next?.[1]?.to ?? edge(0),
        });
        break;
      }
      case 'transform': {
        const c = journeyNodeConfigs.transform.parse(n.config);
        nodes.set(n.id, { ...base, kind: 'transform', set: c.set, expression: c.expression, next: edge(0) });
        break;
      }
      case 'exit':
        nodes.set(n.id, { ...base, kind: 'exit' });
        break;
      default:
        throw new Error(`${n.kind} nodes cannot run yet`);
    }
  });
  if (!trigger) throw new Error('journey without trigger');
  return { start, purpose: def.purpose, trigger, nodes };
}

/** Problems that block publishing a journey: kinds that cannot run yet, and missing e-mail templates or segments. */
export function unsupported(def: JourneyDefinition): string[] {
  return def.nodes
    .filter((n) => !RUNNABLE.has(n.kind))
    .map((n) => `node "${n.id}" is a ${n.kind}, which cannot run yet (arrives in a later phase)`);
}
