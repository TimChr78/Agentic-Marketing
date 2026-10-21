// A journey graph and a pure interpreter step function. The runtime calls `advance` for a
// participant that is due; it runs immediate nodes until the participant has to wait or ends.

export type Node =
  | { id: string; kind: 'trigger'; next: string }
  | { id: string; kind: 'email'; template: string; next: string }
  | { id: string; kind: 'wait'; hours: number; next: string }
  | { id: string; kind: 'waitEvent'; event: string; timeoutHours: number; matched: string; timeout: string }
  | { id: string; kind: 'goal'; next?: string };

// Welcome series, same shape as the demo: trigger → e-mail → wait 2d → wait for click (2d) → branch.
export const welcome: Record<string, Node> = {
  t1: { id: 't1', kind: 'trigger', next: 'e1' },
  e1: { id: 'e1', kind: 'email', template: 'tpl_welcome', next: 'w1' },
  w1: { id: 'w1', kind: 'wait', hours: 48, next: 'b1' },
  b1: { id: 'b1', kind: 'waitEvent', event: 'email_clicked', timeoutHours: 48, matched: 'e2', timeout: 'e3' },
  e2: { id: 'e2', kind: 'email', template: 'tpl_tips', next: 'g1' },
  e3: { id: 'e3', kind: 'email', template: 'tpl_code', next: 'g1' },
  g1: { id: 'g1', kind: 'goal' },
};

export interface ParticipantState {
  node: string;
  status: 'ready' | 'waiting' | 'completed';
  seq: number;
  dueAt: Date | null;
  waitingEvent: string | null;
  /** Set when the awaited event arrived (the participant was woken by the event matcher). */
  matched: boolean;
}

export interface Send {
  node: string;
  seq: number;
  template: string;
}

/**
 * Run from the participant's current node until it waits or finishes.
 * `seq` increments on every node executed; (participant, node, seq) makes side effects idempotent.
 */
export function advance(graph: Record<string, Node>, p: ParticipantState, now: Date): { state: ParticipantState; sends: Send[]; steps: number } {
  let { node, seq } = p;
  const sends: Send[] = [];
  let steps = 0;
  let resumedFromWait = p.status === 'waiting';
  for (let guard = 0; guard < 50; guard++) {
    const n = graph[node];
    steps++;
    seq++;
    switch (n.kind) {
      case 'trigger':
        node = n.next;
        break;
      case 'email':
        sends.push({ node: n.id, seq, template: n.template });
        node = n.next;
        break;
      case 'wait':
        if (!resumedFromWait) {
          return { state: { node, seq, status: 'waiting', dueAt: new Date(now.getTime() + n.hours * 3_600_000), waitingEvent: null, matched: false }, sends, steps };
        }
        resumedFromWait = false;
        node = n.next;
        break;
      case 'waitEvent':
        if (!resumedFromWait) {
          return {
            state: { node, seq, status: 'waiting', dueAt: new Date(now.getTime() + n.timeoutHours * 3_600_000), waitingEvent: n.event, matched: false },
            sends,
            steps,
          };
        }
        resumedFromWait = false;
        node = p.matched ? n.matched : n.timeout;
        break;
      case 'goal':
        if (!n.next) return { state: { node, seq, status: 'completed', dueAt: null, waitingEvent: null, matched: false }, sends, steps };
        node = n.next;
        break;
    }
  }
  throw new Error(`Journey loop guard hit at node ${node}`);
}
