import { createHash } from 'node:crypto';
import type { DecisionQuestion } from '@agentic-marketing/artifacts';
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
  /** waitUntil: the absolute timeout; dueAt is the next check, at most `recheck` away. */
  waitingUntil: Date | null;
  /** Set by the event matcher when the awaited event arrived or the waitUntil condition matched. */
  matched: boolean;
  converted: boolean;
}

export type Effect =
  | { kind: 'email'; node: string; seq: number; template: string }
  | { kind: 'sms'; node: string; seq: number; template: string }
  | { kind: 'push'; node: string; seq: number; template: string }
  | { kind: 'updateProfile'; node: string; seq: number; trait: string; value: string | number | boolean | null }
  /** Ask the AI worker for a decision or text; the participant waits until it answers or the step times out. */
  | {
      kind: 'ai';
      node: string;
      seq: number;
      task: 'decide' | 'generate' | 'score';
      prompt: string;
      /** A decision step's typed question and threshold. */
      questions?: DecisionQuestion[];
      threshold?: number;
      answer?: string;
      scoreKey?: string;
    }
  | { kind: 'webhook'; node: string; seq: number; endpoint: string; data?: string }
  | { kind: 'transform'; node: string; seq: number; set: string; expression: string }
  /** Run a connector action; the participant waits for its result or the timeout. */
  | { kind: 'action'; node: string; seq: number; connection: string; action: string; input: Record<string, unknown> | string }
  /** A text step that got no answer: its slots take their fallback texts. */
  | { kind: 'aiFallback'; node: string; seq: number; prompt: string };

/** What the AI worker answered for a step (stored on the participant). */
export interface AiOutcome {
  option?: string;
  rationale?: string;
  /** A decision step's routing probability in 0–1. */
  probability?: number;
  /** Set when no model answered: no consent, no provider, budget, error or invalid answer. */
  fallback?: string;
}

export interface Step {
  node: string;
  seq: number;
  type: 'step' | 'waiting' | 'resumed' | 'converted' | 'completed' | 'exited';
  detail: string;
}

export interface Env {
  /** Whether the person matches a branch's segment or condition. */
  branch(node: Extract<Graph['nodes'] extends Map<string, infer N> ? N : never, { kind: 'branch' }>): Promise<boolean>;
  /** Whether the person matches a waitUntil condition now. */
  condition(node: Extract<Graph['nodes'] extends Map<string, infer N> ? N : never, { kind: 'waitUntil' }>): Promise<boolean>;
  /** A stable key for deterministic random choices (A/B split). */
  key: string;
  /** The AI worker's answer for a step the participant waited at, if it came in time. */
  ai?(node: string): AiOutcome | undefined;
  /** The outcome of an action step the participant waited at, if it came in time. */
  result?(node: string): { ok: boolean; error?: string } | undefined;
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
    return {
      state: { node: at, status, seq, dueAt: null, waitingEvent: null, waitingUntil: null, matched: false, converted },
      effects,
      steps,
    };
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
      case 'sms':
        effects.push({ kind: 'sms', node: n.id, seq, template: n.template });
        if (!goTo(n.next)) return end('completed', n.id);
        break;
      case 'push':
        effects.push({ kind: 'push', node: n.id, seq, template: n.template });
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
            state: {
              node,
              status: 'waiting',
              seq,
              dueAt: new Date(now.getTime() + n.ms),
              waitingEvent: null,
              waitingUntil: null,
              matched: false,
              converted,
            },
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
              waitingUntil: null,
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
      case 'waitUntil': {
        const deadline = p.waitingUntil ?? new Date(now.getTime() + n.ms);
        if (!resuming) {
          const yes = await env.condition(n);
          steps[steps.length - 1].detail = yes ? 'matched now' : `would wait until ${deadline.toISOString()}`;
          if (yes) {
            if (!goTo(n.matched)) return end('completed', n.id);
            break;
          }
          steps.push({ node: n.id, seq, type: 'waiting', detail: `until ${deadline.toISOString()}` });
          return {
            state: {
              node,
              status: 'waiting',
              seq,
              dueAt: new Date(Math.min(now.getTime() + n.recheckMs, deadline.getTime())),
              waitingEvent: null,
              waitingUntil: deadline,
              matched: false,
              converted,
            },
            effects,
            steps,
          };
        }
        resuming = false;
        if (p.matched) {
          steps[steps.length - 1].detail = 'matched';
          if (!goTo(n.matched)) return end('completed', n.id);
          break;
        }
        if (now.getTime() >= deadline.getTime()) {
          steps[steps.length - 1].detail = 'timed out';
          if (!goTo(n.timeout)) return end('completed', n.id);
          break;
        }
        // The sweeper's fallback check, or an event that was not enough on its own.
        if (await env.condition(n)) {
          steps[steps.length - 1].detail = 'matched';
          if (!goTo(n.matched)) return end('completed', n.id);
          break;
        }
        steps[steps.length - 1].detail = 'not yet';
        return {
          state: {
            node,
            status: 'waiting',
            seq,
            dueAt: new Date(Math.min(now.getTime() + n.recheckMs, deadline.getTime())),
            waitingEvent: null,
            waitingUntil: deadline,
            matched: false,
            converted,
          },
          effects,
          steps,
        };
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
      case 'aiDecide':
      case 'aiGenerate': {
        if (!resuming) {
          effects.push({ kind: 'ai', node: n.id, seq, task: n.kind === 'aiDecide' ? 'decide' : 'generate', prompt: n.prompt });
          steps.push({ node: n.id, seq, type: 'waiting', detail: 'for the AI' });
          return {
            state: {
              node,
              status: 'waiting',
              seq,
              dueAt: new Date(now.getTime() + n.ms),
              waitingEvent: null,
              waitingUntil: null,
              matched: false,
              converted,
            },
            effects,
            steps,
          };
        }
        resuming = false;
        const r = env.ai?.(n.id);
        const why = r ? r.fallback : 'timed out';
        if (n.kind === 'aiGenerate') {
          if (why) effects.push({ kind: 'aiFallback', node: n.id, seq, prompt: n.prompt });
          steps[steps.length - 1].detail = why ? `fallback texts (${why})` : 'AI wrote the content';
          if (!goTo(n.next)) return end('completed', n.id);
          break;
        }
        const chosen = !why && r?.option && n.options.includes(r.option) ? r.option : n.fallback;
        steps[steps.length - 1].detail = why
          ? `fallback ${chosen} (${why})`
          : `AI chose ${chosen}${r?.rationale ? `: ${r.rationale}` : ''}`;
        if (!goTo(n.edges[n.options.indexOf(chosen)] ?? null)) return end('completed', n.id);
        break;
      }
      case 'decision': {
        if (!resuming) {
          effects.push({
            kind: 'ai',
            node: n.id,
            seq,
            task: 'score',
            prompt: '',
            questions: [n.question],
            threshold: n.threshold,
            ...(n.answer ? { answer: n.answer } : {}),
            ...(n.scoreKey ? { scoreKey: n.scoreKey } : {}),
          });
          steps.push({ node: n.id, seq, type: 'waiting', detail: 'for the decision model' });
          return {
            state: {
              node,
              status: 'waiting',
              seq,
              dueAt: new Date(now.getTime() + n.ms),
              waitingEvent: null,
              waitingUntil: null,
              matched: false,
              converted,
            },
            effects,
            steps,
          };
        }
        resuming = false;
        const r = env.ai?.(n.id);
        const why = r ? r.fallback : 'timed out';
        const probability = r?.probability;
        const above = why === undefined && typeof probability === 'number' && probability >= n.threshold;
        steps[steps.length - 1].detail = why
          ? `fallback (${why})`
          : `probability ${probability?.toFixed(3)} ${above ? '≥' : '<'} ${n.threshold}`;
        if (!goTo(above ? n.matched : n.fallback)) return end('completed', n.id);
        break;
      }
      case 'webhook':
        effects.push({ kind: 'webhook', node: n.id, seq, endpoint: n.endpoint, data: n.data });
        if (!goTo(n.next)) return end('completed', n.id);
        break;
      case 'transform':
        effects.push({ kind: 'transform', node: n.id, seq, set: n.set, expression: n.expression });
        if (!goTo(n.next)) return end('completed', n.id);
        break;
      case 'action': {
        if (!resuming) {
          effects.push({ kind: 'action', node: n.id, seq, connection: n.connection, action: n.action, input: n.input });
          steps.push({ node: n.id, seq, type: 'waiting', detail: `for ${n.action}` });
          return {
            state: {
              node,
              status: 'waiting',
              seq,
              dueAt: new Date(now.getTime() + n.ms),
              waitingEvent: null,
              waitingUntil: null,
              matched: false,
              converted,
            },
            effects,
            steps,
          };
        }
        resuming = false;
        const r = env.result?.(n.id);
        steps[steps.length - 1].detail = r?.ok ? 'ok' : `error: ${r ? r.error : 'timed out'}`;
        if (!goTo(r?.ok ? n.ok : n.error)) return end('completed', n.id);
        break;
      }
      // An Exit step ends the path: the person finished the journey (#169). `exited` is for
      // leaving early: a consent withdrawal or a migration that drops the person.
      case 'exit':
        return end('completed', n.id);
    }
  }
  throw new Error(`loop guard: more than 100 steps at once from ${p.node}`);
}
