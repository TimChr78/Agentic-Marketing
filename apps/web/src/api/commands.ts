import type {
  ApprovalRequest,
  DiffItem,
  Effect,
  Journey,
  JourneyEdge,
  JourneyNode,
  NodeKind,
  Principal,
  Purpose,
} from './types';
import { useStore } from '../mock/store';
import { layoutGraph } from '../lib/layout';

// Mock of the command registry (docs/architecture/adr/0005-command-registry-mcp.md).
// Every capability is defined once; the UI calls `exec`, the copilot gets the same list as
// tools, and the Setup screen renders it as the MCP tool catalogue.

type JsonSchema = Record<string, unknown>;

export interface CommandDef {
  name: string;
  description: string;
  effect: Effect;
  input: JsonSchema;
  humansOnly?: boolean;
  run: (input: any, ctx: { principal: Principal }) => unknown;
  summarize?: (input: any, output: any) => string;
}

const S = useStore;
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra });

const nodeKinds: NodeKind[] = ['trigger', 'wait', 'waitEvent', 'branch', 'split', 'email', 'webhook', 'updateProfile', 'aiDecide', 'aiGenerate', 'goal', 'exit'];

function publishedVersion(j: Journey) {
  return j.versions.find((v) => v.state === 'published');
}
function latestVersion(j: Journey) {
  return j.versions[j.versions.length - 1];
}

function diffVersions(before: JourneyNode[] | undefined, after: JourneyNode[]): DiffItem[] {
  if (!before) return after.map((n) => ({ path: `nodes.${n.id}`, kind: 'added', after: `${n.kind} “${n.label}”` }));
  const out: DiffItem[] = [];
  for (const n of after) {
    const b = before.find((x) => x.id === n.id);
    if (!b) out.push({ path: `nodes.${n.id}`, kind: 'added', after: `${n.kind} “${n.label}”` });
    else {
      if (b.label !== n.label) out.push({ path: `nodes.${n.id}.label`, kind: 'changed', before: b.label, after: n.label });
      for (const k of new Set([...Object.keys(b.config), ...Object.keys(n.config)])) {
        if (String(b.config[k] ?? '') !== String(n.config[k] ?? ''))
          out.push({ path: `nodes.${n.id}.config.${k}`, kind: 'changed', before: String(b.config[k] ?? '—'), after: String(n.config[k] ?? '—') });
      }
    }
  }
  for (const b of before) if (!after.find((x) => x.id === b.id)) out.push({ path: `nodes.${b.id}`, kind: 'removed', before: `${b.kind} “${b.label}”` });
  return out;
}

function publishJourney(journeyId: string, versionNumber: number) {
  S.setState((s) => ({
    journeys: s.journeys.map((j) =>
      j.id !== journeyId
        ? j
        : {
            ...j,
            status: 'live',
            versions: j.versions.map((v) =>
              v.number === versionNumber ? { ...v, state: 'published' } : v.state === 'published' ? { ...v, state: 'superseded' } : v,
            ),
          },
    ),
  }));
}

export const commands: CommandDef[] = [
  {
    name: 'profiles.search',
    description: 'Find customer profiles by name, e-mail, city or segment id. Returns a short list without sensitive traits.',
    effect: 'read',
    input: obj({ query: str('Free text, e.g. "anna" or "seg_vip"') }, ['query']),
    run: ({ query }: { query: string }) => {
      const q = query.toLowerCase();
      return S.getState()
        .profiles.filter((p) => [p.name, p.email, p.city, ...p.segments].some((v) => v?.toLowerCase().includes(q)))
        .slice(0, 10)
        .map((p) => ({ id: p.id, name: p.name, city: p.city, segments: p.segments, orders: p.orders }));
    },
    summarize: (i, o) => `“${i.query}” → ${o.length} profiles`,
  },
  {
    name: 'consent.explain',
    description: 'Explain whether a profile may be contacted for a purpose on a channel, and which lawful basis applies.',
    effect: 'read',
    input: obj(
      {
        profileId: str('Profile id (prf_…)'),
        purpose: str('Purpose key', { enum: ['onboarding', 'marketing_email', 'web_personalization', 'ai_processing'] }),
      },
      ['profileId', 'purpose'],
    ),
    run: ({ profileId, purpose }: { profileId: string; purpose: Purpose }) => {
      const p = S.getState().profiles.find((x) => x.id === profileId);
      if (!p) throw new Error(`No profile ${profileId}`);
      const rec = p.consent.find((c) => c.purpose === purpose);
      if (!rec) return { allowed: purpose === 'onboarding', basis: 'contract', reason: 'Service messages to account holders.' };
      const allowed = rec.basis === 'consent' ? rec.status === 'granted' : rec.status !== 'objected' && rec.status !== 'denied';
      return {
        allowed,
        basis: rec.basis,
        status: rec.status,
        source: rec.source,
        recordedAt: new Date(rec.at).toISOString().slice(0, 10),
        reason: allowed
          ? rec.basis === 'legitimate_interest'
            ? 'Existing customer (soft opt-in), no objection recorded.'
            : 'Consent granted.'
          : rec.status === 'objected'
            ? 'The person objected (unsubscribed). Objections always win over legitimate interest.'
            : 'No valid consent.',
      };
    },
    summarize: (i, o) => `${i.profileId} / ${i.purpose} → ${o.allowed ? 'allowed' : 'blocked'}`,
  },
  {
    name: 'messages.explainDelivery',
    description: 'Explain step by step why a profile did or did not receive messages from a journey.',
    effect: 'read',
    input: obj({ profileId: str('Profile id'), journeyId: str('Journey id (jrn_…)') }, ['profileId', 'journeyId']),
    run: ({ profileId, journeyId }: { profileId: string; journeyId: string }) => {
      const st = S.getState();
      const p = st.profiles.find((x) => x.id === profileId);
      const j = st.journeys.find((x) => x.id === journeyId);
      if (!p || !j) throw new Error('Unknown profile or journey');
      const objected = p.consent.some((c) => c.purpose === 'marketing_email' && c.status === 'objected');
      return {
        journey: j.name,
        steps: [
          { step: 'Trigger', result: `Entered ${j.name} (v${publishedVersion(j)?.number}) 3 days ago` },
          { step: 'Wait 1 hour', result: 'Completed' },
          { step: 'Ordered in the meantime?', result: 'No → continue' },
          { step: 'A/B: incentive', result: 'Assigned variant A' },
          objected
            ? { step: 'Send gateway', result: 'Suppressed: objection recorded for marketing_email (unsubscribe link, 41 days ago)' }
            : { step: 'Send gateway', result: 'Delivered via SMTP relay, clicked after 2 h' },
        ],
      };
    },
    summarize: (_i, o) => `${o.journey}: ${o.steps[o.steps.length - 1].result.split(':')[0]}`,
  },
  {
    name: 'segments.estimate',
    description: 'Estimate the size of an audience for a segment definition (segment DSL or plain description).',
    effect: 'read',
    input: obj({ definition: str('Segment definition') }, ['definition']),
    run: ({ definition }: { definition: string }) => {
      let h = 0;
      for (const c of definition) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return { estimatedSize: 1500 + (h % 6000), reachableByEmail: 0.78 };
    },
    summarize: (_i, o) => `≈ ${o.estimatedSize.toLocaleString('en')} profiles`,
  },
  {
    name: 'segments.create',
    description: 'Create a segment. Real-time segments emit entered/exited events that can trigger journeys.',
    effect: 'write',
    input: obj({ name: str('Segment name'), definition: str('Segment definition'), realtime: { type: 'boolean' } }, ['name', 'definition']),
    run: ({ name, definition, realtime }: { name: string; definition: string; realtime?: boolean }, { principal }) => {
      const id = `seg_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`;
      const size = (commands.find((c) => c.name === 'segments.estimate')!.run({ definition }, { principal }) as { estimatedSize: number }).estimatedSize;
      S.setState((s) => ({ segments: [...s.segments.filter((x) => x.id !== id), { id, name, definition, size, realtime: !!realtime, author: principal }] }));
      return { id, size };
    },
    summarize: (i, o) => `${i.name} (${o.size.toLocaleString('en')})`,
  },
  {
    name: 'journeys.list',
    description: 'List journeys with status, published version and key metrics.',
    effect: 'read',
    input: obj({}),
    run: () =>
      S.getState().journeys.map((j) => ({ id: j.id, name: j.name, status: j.status, version: publishedVersion(j)?.number ?? null, ...j.metrics })),
    summarize: (_i, o) => `${o.length} journeys`,
  },
  {
    name: 'journeys.createDraft',
    description:
      'Create a new journey as a draft. Nodes are listed in order; each node may name the ids it continues to in `next` (default: the following node). Node kinds: ' +
      nodeKinds.join(', ') +
      '. Durations are ISO-8601 (P2D, PT1H).',
    effect: 'write',
    input: obj(
      {
        name: str('Journey name'),
        purpose: str('Purpose (lawful basis is looked up from it)', { enum: ['onboarding', 'marketing_email'] }),
        goal: str('Conversion goal, e.g. "Order within 14 days"'),
        nodes: {
          type: 'array',
          items: obj(
            {
              id: str('Short id, e.g. n1'),
              kind: str('Node kind', { enum: nodeKinds }),
              label: str('Human readable label'),
              config: { type: 'object', description: 'Node settings, e.g. {"duration":"P3D"} or {"template":"tpl_winback"}' },
              next: { type: 'array', items: obj({ to: str('Target node id'), label: str('Edge label, e.g. yes / no / A') }, ['to']) },
            },
            ['id', 'kind', 'label'],
          ),
        },
      },
      ['name', 'purpose', 'goal', 'nodes'],
    ),
    run: (
      input: {
        name: string;
        purpose: Purpose;
        goal: string;
        nodes: { id: string; kind: NodeKind; label: string; config?: JourneyNode['config']; next?: { to: string; label?: string }[] }[];
      },
      { principal },
    ) => {
      const nodes: JourneyNode[] = input.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, config: n.config ?? {}, position: { x: 0, y: 0 } }));
      const edges: JourneyEdge[] = [];
      input.nodes.forEach((n, i) => {
        const next = n.next ?? (i < input.nodes.length - 1 && !['exit', 'goal'].includes(n.kind) ? [{ to: input.nodes[i + 1].id }] : []);
        next.forEach((x) => edges.push({ id: `${n.id}-${x.to}`, source: n.id, target: x.to, label: x.label }));
      });
      const id = `jrn_${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)}`;
      const journey: Journey = {
        id,
        name: input.name,
        purpose: input.purpose,
        status: 'draft',
        goal: input.goal,
        metrics: { entered: 0, active: 0, conversion: 0, holdoutUplift: 0 },
        versions: [
          { number: 1, state: 'draft', author: principal, note: 'Initial draft', createdAt: Date.now(), nodes: layoutGraph(nodes, edges), edges },
        ],
      };
      S.setState((s) => ({ journeys: [...s.journeys.filter((j) => j.id !== id), journey] }));
      return { journeyId: id, version: 1, state: 'draft', nodes: nodes.length };
    },
    summarize: (i, o) => `${i.name} → ${o.journeyId} v1 (draft)`,
  },
  {
    name: 'journeys.updateDraft',
    description: 'Replace the graph of a journey draft. If the latest version is published or in review, a new draft version is created.',
    effect: 'write',
    input: obj({ journeyId: str('Journey id'), nodes: { type: 'array' }, edges: { type: 'array' } }, ['journeyId', 'nodes', 'edges']),
    run: ({ journeyId, nodes, edges }: { journeyId: string; nodes: JourneyNode[]; edges: JourneyEdge[] }, { principal }) => {
      const j = S.getState().journeys.find((x) => x.id === journeyId);
      if (!j) throw new Error('Unknown journey');
      const latest = latestVersion(j);
      const isDraft = latest.state === 'draft';
      const number = isDraft ? latest.number : latest.number + 1;
      S.setState((s) => ({
        journeys: s.journeys.map((x) =>
          x.id !== journeyId
            ? x
            : {
                ...x,
                versions: isDraft
                  ? x.versions.map((v) => (v.number === number ? { ...v, nodes, edges } : v))
                  : [...x.versions, { number, state: 'draft', author: principal, note: 'Edited in journey builder', createdAt: Date.now(), nodes, edges }],
              },
        ),
      }));
      return { version: number, state: 'draft' };
    },
    summarize: (i, o) => `${i.journeyId} v${o.version}: ${i.nodes.length} nodes`,
  },
  {
    name: 'journeys.simulate',
    description: 'Dry-run a journey for one profile with a virtual clock. Returns the path taken and every decision.',
    effect: 'read',
    input: obj({ journeyId: str('Journey id'), profileId: str('Profile id (optional, defaults to a sample customer)') }, ['journeyId']),
    run: ({ journeyId, profileId }: { journeyId: string; profileId?: string }) => simulate(journeyId, profileId),
    summarize: (_i, o) => `${o.path.length} steps → ${o.outcome}`,
  },
  {
    name: 'journeys.requestPublish',
    description: 'Publish the latest draft of a journey. Depending on the workspace approval policy this publishes directly or opens an approval request.',
    effect: 'publish',
    input: obj({ journeyId: str('Journey id'), note: str('Change note for reviewers') }, ['journeyId', 'note']),
    run: ({ journeyId, note }: { journeyId: string; note: string }, { principal }) => {
      const st = S.getState();
      const j = st.journeys.find((x) => x.id === journeyId);
      if (!j) throw new Error(`No journey ${journeyId}`);
      const latest = latestVersion(j);
      if (latest.state === 'published') return { status: 'already_published', version: latest.number };
      const needsApproval =
        st.approvalPolicy === 'all_publishes' || (st.approvalPolicy === 'agent_changes' && (principal.type === 'agent' || latest.author.type === 'agent'));
      if (!needsApproval) {
        publishJourney(journeyId, latest.number);
        return { status: 'published', version: latest.number };
      }
      const req: ApprovalRequest = {
        id: `apr_${Date.now().toString(36)}`,
        artifactType: 'journey',
        artifactId: j.id,
        artifactName: j.name,
        fromVersion: publishedVersion(j)?.number,
        toVersion: latest.number,
        requestedBy: principal,
        status: 'pending',
        createdAt: Date.now(),
        summary: note,
        changes: diffVersions(publishedVersion(j)?.nodes, latest.nodes),
      };
      S.setState((s) => ({
        approvals: [req, ...s.approvals],
        journeys: s.journeys.map((x) =>
          x.id === journeyId ? { ...x, versions: x.versions.map((v) => (v.number === latest.number ? { ...v, state: 'in_review' } : v)) } : x,
        ),
      }));
      return { status: 'awaiting_approval', approvalId: req.id, policy: st.approvalPolicy };
    },
    summarize: (_i, o) => o.status.replace(/_/g, ' '),
  },
  {
    name: 'artifacts.approve',
    description: 'Approve a pending change and publish it. Only human principals may approve.',
    effect: 'publish',
    humansOnly: true,
    input: obj({ approvalId: str('Approval request id') }, ['approvalId']),
    run: ({ approvalId }: { approvalId: string }, { principal }) => {
      if (principal.type !== 'user') throw new Error('Agents cannot approve their own or others’ changes.');
      const req = S.getState().approvals.find((a) => a.id === approvalId);
      if (!req) throw new Error('Unknown approval');
      if (req.artifactType === 'journey') publishJourney(req.artifactId, req.toVersion);
      if (req.artifactType === 'template')
        S.setState((s) => ({ templates: s.templates.map((t) => (t.id === req.artifactId ? { ...t, version: req.toVersion, updatedAt: Date.now() } : t)) }));
      S.setState((s) => ({ approvals: s.approvals.map((a) => (a.id === approvalId ? { ...a, status: 'approved' } : a)) }));
      return { status: 'published', artifact: req.artifactName, version: req.toVersion };
    },
    summarize: (_i, o) => `${o.artifact} v${o.version} published`,
  },
  {
    name: 'artifacts.reject',
    description: 'Reject a pending change.',
    effect: 'write',
    humansOnly: true,
    input: obj({ approvalId: str('Approval request id') }, ['approvalId']),
    run: ({ approvalId }: { approvalId: string }) => {
      const req = S.getState().approvals.find((a) => a.id === approvalId);
      S.setState((s) => ({
        approvals: s.approvals.map((a) => (a.id === approvalId ? { ...a, status: 'rejected' } : a)),
        journeys: s.journeys.map((j) =>
          j.id === req?.artifactId ? { ...j, versions: j.versions.map((v) => (v.number === req.toVersion ? { ...v, state: 'draft' } : v)) } : j,
        ),
      }));
      return { status: 'rejected' };
    },
  },
  {
    name: 'templates.list',
    description: 'List e-mail templates (MJML + Liquid) with version and purpose.',
    effect: 'read',
    input: obj({}),
    run: () => S.getState().templates.map(({ id, name, subject, version, purpose }) => ({ id, name, subject, version, purpose })),
    summarize: (_i, o) => `${o.length} templates`,
  },
  {
    name: 'templates.create',
    description: 'Create an e-mail template draft from MJML with Liquid placeholders such as {{ profile.first_name }}.',
    effect: 'write',
    input: obj({ name: str('Template name'), subject: str('Subject line (Liquid allowed)'), mjml: str('Full MJML document') }, ['name', 'subject', 'mjml']),
    run: ({ name, subject, mjml }: { name: string; subject: string; mjml: string }, { principal }) => {
      const id = `tpl_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)}`;
      S.setState((s) => ({
        templates: [...s.templates.filter((t) => t.id !== id), { id, name, subject, mjml, purpose: 'marketing_email', version: 1, updatedAt: Date.now(), author: principal }],
      }));
      return { templateId: id, version: 1 };
    },
    summarize: (i) => i.name,
  },
  {
    name: 'templates.saveDraft',
    description: 'Save a new draft version of an existing e-mail template.',
    effect: 'write',
    input: obj({ templateId: str('Template id'), subject: str('Subject line'), mjml: str('Full MJML document') }, ['templateId', 'subject', 'mjml']),
    run: ({ templateId, subject, mjml }: { templateId: string; subject: string; mjml: string }, { principal }) => {
      let version = 0;
      S.setState((s) => ({
        templates: s.templates.map((t) => (t.id === templateId ? { ...t, subject, mjml, version: (version = t.version + 1), updatedAt: Date.now(), author: principal } : t)),
      }));
      return { templateId, version };
    },
    summarize: (i, o) => `${i.templateId} v${o.version}`,
  },
  {
    name: 'analytics.emailPerformance',
    description: 'E-mail performance for the last N days: sent, delivered, click rate, unsubscribe rate, attributed conversions and revenue (DKK).',
    effect: 'read',
    input: obj({ days: { type: 'integer', minimum: 1, maximum: 30 } }, ['days']),
    run: ({ days }: { days: number }) => {
      const rows = S.getState().daily.slice(-days);
      const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (r[k] as number), 0);
      const sent = sum('sent');
      return {
        days,
        sent,
        delivered: sum('delivered'),
        clickRate: +((sum('clicks') / sent) * 100).toFixed(2),
        unsubscribeRate: +((sum('unsubscribes') / sent) * 100).toFixed(3),
        conversions: sum('conversions'),
        revenueDkk: sum('revenue'),
        bestDay: rows.reduce((a, r) => (r.conversions > a.conversions ? r : a)).day,
      };
    },
    summarize: (i, o) => `${i.days}d: CTR ${o.clickRate}%`,
  },
  {
    name: 'analytics.journeyFunnel',
    description: 'Per-step funnel for a journey: how many entered each step, how many are waiting, and holdout uplift.',
    effect: 'read',
    input: obj({ journeyId: str('Journey id') }, ['journeyId']),
    run: ({ journeyId }: { journeyId: string }) => {
      const j = S.getState().journeys.find((x) => x.id === journeyId);
      if (!j) throw new Error('Unknown journey');
      return {
        journey: j.name,
        conversion: j.metrics.conversion,
        holdoutUplift: j.metrics.holdoutUplift,
        steps: (publishedVersion(j) ?? latestVersion(j)).nodes.map((n) => ({ step: n.label, ...n.stats })),
      };
    },
    summarize: (_i, o) => `${o.journey}: ${o.conversion}% conv.`,
  },
];

export function simulate(journeyId: string, profileId?: string) {
  const st = S.getState();
  const j = st.journeys.find((x) => x.id === journeyId);
  if (!j) throw new Error('Unknown journey');
  const p = st.profiles.find((x) => x.id === profileId) ?? st.profiles[2];
  const v = latestVersion(j);
  const path: { nodeId: string; label: string; clock: string; note: string }[] = [];
  let current = v.nodes.find((n) => !v.edges.some((e) => e.target === n.id));
  let hours = 0;
  const fmt = (h: number) => (h < 24 ? `+${h}h` : `+${Math.floor(h / 24)}d ${h % 24 ? `${h % 24}h` : ''}`.trim());
  const durationHours = (d: unknown) => {
    const m = String(d ?? '').match(/P(?:(\d+)D)?(?:T(\d+)H)?/);
    return m ? Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0) : 0;
  };
  let guard = 0;
  while (current && guard++ < 30) {
    let note = '';
    let pick: JourneyEdge | undefined;
    const out = v.edges.filter((e) => e.source === current!.id);
    switch (current.kind) {
      case 'trigger':
        note = `${p.name} matched “${current.config.event ?? current.label}”`;
        break;
      case 'wait':
        hours += durationHours(current.config.duration) || 24;
        note = `Timer set, resumes ${fmt(hours)}`;
        break;
      case 'waitEvent':
        hours += durationHours(current.config.timeout) || 48;
        pick = out.find((e) => e.label === (p.orders > 2 ? 'clicked' : 'timeout')) ?? out[0];
        note = p.orders > 2 ? 'Event arrived before timeout' : 'Timed out without event';
        break;
      case 'branch':
        pick = out.find((e) => e.label === 'no') ?? out[0];
        note = `Condition false for ${p.traits.first_name}`;
        break;
      case 'split':
        pick = out[p.name.length % out.length];
        note = `Sticky assignment → variant ${pick?.label ?? 'A'} (hash of profile id)`;
        break;
      case 'email': {
        const c = p.consent.find((x) => x.purpose === (current!.config.purpose ?? 'marketing_email'));
        const blocked = c?.status === 'objected' || (c?.basis === 'consent' && c.status !== 'granted');
        note = blocked ? `Suppressed by send gateway: ${c?.status} (${c?.basis.replace('_', ' ')})` : `Rendered ${current.config.template ?? 'template'} → SMTP relay`;
        break;
      }
      case 'aiDecide':
        pick = out[0];
        note = `Model chose “${pick?.label ?? 'continue'}” (confidence 0.81); fallback not needed`;
        break;
      case 'aiGenerate':
        note = `Generated ${current.config.slot ?? 'content'} within ${current.config.maxChars ?? 200} chars, passed lint`;
        break;
      case 'goal':
        note = `Goal check: ${p.orders > 1 ? 'converted' : 'not yet'} within window`;
        break;
      case 'exit':
        note = 'Left the journey';
        break;
      default:
        note = 'Executed';
    }
    path.push({ nodeId: current.id, label: current.label, clock: fmt(hours), note });
    const next = pick ?? out[0];
    current = next ? v.nodes.find((n) => n.id === next.target) : undefined;
  }
  return { profile: p.name, outcome: path[path.length - 1]?.note ?? 'no path', path };
}

let auditId = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a command the way the real command layer would: authz, validation, audit log. */
export async function exec<T = any>(name: string, input: unknown, principal: Principal = { type: 'user', name: 'Tim' }): Promise<T> {
  const def = commands.find((c) => c.name === name);
  const log = (ok: boolean, summary: string) =>
    useStore.setState((s) => ({
      audit: [{ id: `a${++auditId}`, at: Date.now(), command: name, principal, effect: def?.effect ?? 'read', summary, ok }, ...s.audit].slice(0, 200),
    }));
  if (!def) {
    log(false, 'Unknown command');
    throw new Error(`Unknown command ${name}`);
  }
  await wait(120 + Math.random() * 180);
  try {
    if (def.humansOnly && principal.type !== 'user') throw new Error(`${name} requires a human principal`);
    const out = await def.run(input ?? {}, { principal });
    log(true, def.summarize?.(input, out) ?? 'ok');
    return out as T;
  } catch (err) {
    log(false, (err as Error).message);
    throw err;
  }
}

/** Tool name used by LLM providers (dots are not allowed in tool names). */
export const toolName = (command: string) => command.replace('.', '__');
export const commandName = (tool: string) => tool.replace('__', '.');
