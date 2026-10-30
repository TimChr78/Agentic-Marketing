import { edgesOf, type JNode, KINDS, maxEdges } from './model';

// What a step still needs before the journey can be published (#33), checked in the browser so
// markers appear as you edit. The server's draft warnings (after each autosave) are merged in.

export function localWarnings(nodes: JNode[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (id: string, m: string) => {
    out[id] ??= [];
    out[id].push(m);
  };
  const edges = edgesOf(nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const trigger = nodes.find((n) => n.kind === 'trigger');
  const reach = new Set<string>();
  if (trigger) {
    const q = [trigger.id];
    while (q.length) {
      const id = q.shift()!;
      if (reach.has(id)) continue;
      reach.add(id);
      for (const e of edges) if (e.source === id && ids.has(e.target)) q.push(e.target);
    }
  }
  for (const n of nodes) {
    const c = n.config as Record<string, unknown>;
    const empty = (k: string) => c[k] === undefined || c[k] === null || c[k] === '';
    switch (n.kind) {
      case 'trigger':
        if (empty('event') === empty('segment')) add(n.id, 'Choose an event or a segment that starts the journey.');
        break;
      case 'email':
      case 'sms':
      case 'push':
        if (empty('template')) add(n.id, `Choose the ${KINDS[n.kind].label.toLowerCase()} template to send.`);
        break;
      case 'wait':
        if (empty('duration')) add(n.id, 'Set how long to wait.');
        break;
      case 'waitEvent':
      case 'goal':
        if (empty('event')) add(n.id, 'Choose the event to wait for.');
        break;
      case 'waitUntil':
        if (c.condition === undefined || c.condition === null) add(n.id, 'Set the condition to wait for.');
        break;
      case 'branch':
        if (empty('segment') && c.condition === undefined) add(n.id, 'Set the condition or segment that decides yes or no.');
        break;
      case 'aiDecide':
      case 'aiGenerate':
        if (empty('prompt')) add(n.id, 'Choose the AI prompt.');
        break;
      case 'webhook':
        if (empty('endpoint')) add(n.id, 'Choose the webhook endpoint.');
        break;
      case 'action':
        if (empty('connection')) add(n.id, 'Choose the connection.');
        break;
      case 'transform':
        if (empty('expression')) add(n.id, 'Write the expression.');
        break;
      case 'updateProfile':
        if (empty('trait')) add(n.id, 'Choose the trait to set.');
        break;
    }
    const outs = edges.filter((e) => e.source === n.id).length;
    if (maxEdges(n) > 1 && outs < maxEdges(n) && (n.kind === 'branch' || n.kind === 'split' || n.kind === 'aiDecide'))
      add(n.id, `Connect all ${maxEdges(n)} outcomes (${outs} connected).`);
    if (trigger && n.id !== trigger.id && !reach.has(n.id)) add(n.id, 'Not reachable from the trigger: connect a step to it.');
  }
  if (!trigger) for (const n of nodes.slice(0, 1)) add(n.id, 'A journey needs a trigger step.');
  return out;
}

export function mergeWarnings(a: Record<string, string[]>, server: { nodeId: string | null; message: string }[]) {
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, [...v]]));
  for (const w of server) {
    if (w.nodeId && !out[w.nodeId]?.some((m) => m === w.message)) {
      out[w.nodeId] ??= [];
      out[w.nodeId].push(w.message);
    }
  }
  return out;
}
