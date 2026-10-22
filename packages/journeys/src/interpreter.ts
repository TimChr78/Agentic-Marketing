import { createHash } from 'node:crypto';
import type { Graph } from './graph';

// The interpreter: from a participant's current node, run immediate nodes until the participant
// waits or ends. `seq` increases with every node executed; (participant, node, seq) keys every
// side effect, so running the same step again after a crash changes nothing.

export interface ParticipantState {
  node: string;
  status: 'ready' | 'waiting' | 'completed' | 'exited' | 'failed';
  seq: number;
  dueAt: Date | null;
  waitingEvent: string | null;
  /** Set by the event matcher when the awaited event arrived. */
  matched: boolean;
  converted: boolean;
}

export type Effect =
  | { kind: 'email'; node: string; seq: number; template: string }
  | { kind: 'updateProfile'; node: string; seq: number; trait: string; value: string | number | boolean | null };

export interface Step {
  node: string;
  seq: number;
  type: 'step' | 'waiting' | 'resumed' | 'converted' | 'completed' | 'exited';
  detail: string;
}

export interface Env {
  /** Whether the person matches a branch's segment or condition. */
  branch(node: Extract<Graph['nodes'] extends Map<string, infer N> ? N : never, { kind: 'branch' }>): Promise<boolean>;
  /** A stable key for deterministic random choices (A/B split). */
  key: string;
}

/** Deterministic weighted choice: the same participant and node always take the same edge. */
export function pick(weights: number[], key: string): number {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const r = (createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32) * total;
  let acc = 0;
  for (const [i, w] of weights.entries()) {
    acc += w;
    if (r < acc) return i;
  }
  return weights.length - 1;
}

export async function advance(
  graph: Graph,
  p: ParticipantState,
  now: Date,
  env: Env,
): Promise<{ state: ParticipantState; effects: Effect[]; steps: Step[] }> {
  let { node, seq, converted } = p;
  const effects: Effect[] = [];
  const steps: Step[] = [];
  let resuming = p.status === 'waiting';
  const end = (status: 'completed' | 'exited', at: string) => {
    steps.push({ node: at, seq, type: status, detail: '' });
    return { state: { node: at, status, seq, dueAt: null, waitingEvent: null, matched: false, converted }, effects, steps };
  };
  const goTo = (next: string | null) => {
    if (next === null) return false;
    node = next;
    return true;
  };

  for (let guard = 0; guard < 100; guard++) {
    const n = graph.nodes.get(node);
    if (!n) throw new Error(`unknown node ${node}`);
    seq++;
    steps.push({ node: n.id, seq, type: resuming ? 'resumed' : 'step', detail: '' });
    switch (n.kind) {
      case 'trigger':
        if (!goTo(n.next)) return end('completed', n.id);
        break;
      case 'email':
        effects.push({ kind: 'email', node: n.id, seq, template: n.template });
        if (!goTo(n.next)) return end('completed', n.id);
        break;
      case 'updateProfile':
        effects.push({ kind: 'updateProfile', node: n.id, seq, trait: n.trait, value: n.value });
        if (!goTo(n.next)) return end('completed', n.id);
        break;
      case 'wait':
        if (!resuming) {
          steps.push({ node: n.id, seq, type: 'waiting', detail: `until ${new Date(now.getTime() + n.ms).toISOString()}` });
          return {
            state: { node, status: 'waiting', seq, dueAt: new Date(now.getTime() + n.ms), waitingEvent: null, matched: false, converted },
            effects,
            steps,
          };
        }
        resuming = false;
        if (!goTo(n.next)) return end('completed', n.id);
        break;
      case 'waitEvent':
      case 'goal': {
        if (!resuming) {
          steps.push({ node: n.id, seq, type: 'waiting', detail: `for ${n.event}` });
          return {
            state: {
              node,
              status: 'waiting',
              seq,
              dueAt: new Date(now.getTime() + n.ms),
              waitingEvent: n.event,
              matched: false,
              converted,
            },
            effects,
            steps,
          };
        }
        resuming = false;
        if (p.matched && n.kind === 'goal') {
          converted = true;
          steps.push({ node: n.id, seq, type: 'converted', detail: n.event });
        }
        if (!goTo(p.matched ? n.matched : n.timeout)) return end('completed', n.id);
        break;
      }
      case 'branch': {
        const yes = await env.branch(n);
        steps[steps.length - 1].detail = yes ? 'yes' : 'no';
        if (!goTo(yes ? n.yes : n.no)) return end('completed', n.id);
        break;
      }
      case 'split': {
        const i = pick(n.weights, `${env.key}:${n.id}`);
        steps[steps.length - 1].detail = `variant ${i + 1}`;
        if (!goTo(n.edges[i] ?? null)) return end('completed', n.id);
        break;
      }
      case 'exit':
        return end('exited', n.id);
    }
  }
  throw new Error(`loop guard: more than 100 steps at once from ${p.node}`);
}
