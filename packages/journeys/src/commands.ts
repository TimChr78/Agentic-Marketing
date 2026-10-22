import { artifactTypes, type JourneyDefinition, publishValidators } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newUuid } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { checkRecipient } from '@agentic-marketing/email';
import { contextFor, durationSeconds, evaluate, publishedSegments } from '@agentic-marketing/segments';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { compile, unsupported } from './graph';
import { advance, type ParticipantState } from './interpreter';

const JourneyId = z.string().regex(/^jrn_[0-9a-f]{32}$/);

/** Journeys can be published only with runnable nodes and published templates and segments. */
publishValidators.set('journey', async (content, tx: Tx) => {
  const def = content as JourneyDefinition;
  const problems = unsupported(def);
  const templates = def.nodes.filter((n) => n.kind === 'email').map((n) => String(n.config.template));
  const segments = def.nodes.flatMap((n) =>
    (n.kind === 'trigger' || n.kind === 'branch') && n.config.segment ? [String(n.config.segment)] : [],
  );
  const refs = [...templates, ...segments];
  if (refs.length) {
    const found = await tx
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(and(inArray(schema.artifacts.id, refs), isNotNull(schema.artifacts.publishedVersion)));
    const ok = new Set(found.map((f) => f.id));
    for (const r of new Set(refs))
      if (!ok.has(r)) problems.push(`${r} is not a published ${r.startsWith('eml_') ? 'e-mail template' : 'segment'}`);
  }
  return problems;
});

async function loadDefinition(tx: Tx, id: string, version?: number) {
  const [v] = await tx
    .select({ number: schema.artifactVersions.number, content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, id), version ? eq(schema.artifactVersions.number, version) : undefined))
    .orderBy(desc(schema.artifactVersions.number))
    .limit(1);
  if (!v) throw new AppError('not_found', `No journey ${id}${version ? ` version ${version}` : ''}.`);
  return { version: v.number, def: artifactTypes.journey.content.parse(v.content) as JourneyDefinition };
}

export const journeyStats = defineCommand({
  name: 'journeys.stats',
  title: 'Journey statistics',
  description: 'How many people are where in a journey right now, and how many reached each node, converted, completed or exited.',
  input: z.object({ artifactId: JourneyId }),
  output: z.object({
    now: z.object({
      ready: z.number(),
      waiting: z.number(),
      completed: z.number(),
      exited: z.number(),
      failed: z.number(),
      converted: z.number(),
    }),
    waitingAt: z.record(z.string(), z.number()).describe('Node id → people waiting there'),
    reached: z.record(z.string(), z.number()).describe('Node id → people who passed it'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({
        status: schema.journeyParticipants.status,
        node: schema.journeyParticipants.node,
        converted: schema.journeyParticipants.converted,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.journeyParticipants)
      .where(eq(schema.journeyParticipants.journeyId, input.artifactId))
      .groupBy(schema.journeyParticipants.status, schema.journeyParticipants.node, schema.journeyParticipants.converted);
    const now = { ready: 0, waiting: 0, completed: 0, exited: 0, failed: 0, converted: 0 };
    const waitingAt: Record<string, number> = {};
    for (const r of rows) {
      now[r.status] += r.n;
      if (r.converted) now.converted += r.n;
      if (r.status === 'waiting') waitingAt[r.node] = (waitingAt[r.node] ?? 0) + r.n;
    }
    const reached: Record<string, number> = {};
    for (const c of await ctx.services.events.journeyCounts(ctx.principal.workspaceId, input.artifactId))
      if (c.type === 'step' || c.type === 'resumed') reached[c.node] = Math.max(reached[c.node] ?? 0, c.count);
    return { now, waitingAt, reached };
  },
});

export const enrollProfiles = defineCommand({
  name: 'journeys.enroll',
  title: 'Put people into a journey',
  description:
    'Enter people into a published journey directly (an API or agent trigger), regardless of its trigger. Re-entry rules still apply.',
  input: z.object({
    artifactId: JourneyId,
    profileIds: z
      .array(z.string().regex(/^prf_[0-9a-f]{32}$/))
      .min(1)
      .max(1000),
    reason: z.string().max(200).optional(),
  }),
  output: z.object({ entered: z.number().int(), skipped: z.number().int() }),
  permission: 'messages:send',
  effect: 'write',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [a] = await ctx.tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, input.artifactId));
    if (!a?.publishedVersion) throw new AppError('not_found', `Journey ${input.artifactId} has no published version.`);
    const { def } = await loadDefinition(ctx.tx, a.id, a.publishedVersion);
    const g = compile(def);
    let entered = 0;
    for (const profileId of input.profileIds) {
      if (g.trigger.reentry !== 'always') {
        const [prior] = await ctx.tx
          .select({ id: schema.journeyParticipants.id })
          .from(schema.journeyParticipants)
          .where(
            and(
              eq(schema.journeyParticipants.journeyId, a.id),
              eq(schema.journeyParticipants.profileId, profileId),
              g.trigger.reentry === 'after_exit' ? inArray(schema.journeyParticipants.status, ['ready', 'waiting']) : undefined,
            ),
          )
          .limit(1);
        if (prior) continue;
      }
      const [p] = await ctx.tx.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.id, profileId));
      if (!p) continue;
      await ctx.tx.insert(schema.journeyParticipants).values({
        workspaceId: ctx.principal.workspaceId,
        journeyId: a.id,
        version: a.publishedVersion,
        profileId,
        entryKey: `manual:${newUuid()}`,
        node: g.start,
        status: 'ready',
        dueAt: new Date(),
        context: { event: { name: 'manual', properties: { reason: input.reason ?? '' } } },
      });
      entered++;
    }
    return { entered, skipped: input.profileIds.length - entered };
  },
});

export const simulateJourney = defineCommand({
  name: 'journeys.simulate',
  title: 'Simulate a journey',
  description:
    'Walk through a journey version (default: latest) on a virtual clock, without sending anything. With a profile, e-mail steps say whether the gateway would send or why not, and branches use the person’s data. `events` lets you script what the person does (e.g. clicks after 1 day).',
  input: z.object({
    artifactId: JourneyId,
    version: z.number().int().min(1).optional(),
    profileId: z
      .string()
      .regex(/^prf_[0-9a-f]{32}$/)
      .optional(),
    events: z
      .array(z.object({ event: z.string(), after: z.string().describe('ISO duration after entry, e.g. "P1D"') }))
      .max(50)
      .default([]),
    branches: z
      .record(z.string(), z.enum(['yes', 'no']))
      .default({})
      .describe('Answers for branch nodes when there is no profile (default no)'),
    maxDays: z.number().int().min(1).max(365).default(90),
  }),
  output: z.object({
    version: z.number().int(),
    outcome: z.enum(['completed', 'exited', 'waiting']),
    converted: z.boolean(),
    steps: z.array(z.object({ after: z.string(), node: z.string(), label: z.string(), kind: z.string(), detail: z.string() })),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const { version, def } = await loadDefinition(ctx.tx, input.artifactId, input.version);
    let graph: ReturnType<typeof compile>;
    try {
      graph = compile(def);
    } catch (e) {
      throw new AppError('invalid_input', `This journey cannot run: ${(e as Error).message}`);
    }
    const ws = ctx.principal.workspaceId;
    const start = new Date('2026-01-01T09:00:00Z');
    const scripted = input.events
      .map((e) => ({ event: e.event, at: start.getTime() + durationSeconds(e.after) * 1000 }))
      .sort((a, b) => a.at - b.at);
    const segments = input.profileId ? await publishedSegments(ctx.tx) : [];
    const fmt = (t: number) => {
      const m = Math.round((t - start.getTime()) / 60_000);
      return m < 60
        ? `${m}m`
        : m < 1440
          ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
          : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)}h` : ''}`;
    };
    const steps: { after: string; node: string; label: string; kind: string; detail: string }[] = [];
    let state: ParticipantState = {
      node: graph.start,
      status: 'ready',
      seq: 0,
      dueAt: start,
      waitingEvent: null,
      matched: false,
      converted: false,
    };
    let clock = start.getTime();
    const limit = start.getTime() + input.maxDays * 86_400_000;
    while (state.status === 'ready' || state.status === 'waiting') {
      const out = await advance(graph, state, new Date(clock), {
        key: `simulation:${input.profileId ?? 'anyone'}`,
        branch: async (n) => {
          if (!input.profileId) return input.branches[n.id] === 'yes';
          if (n.segment) {
            const [m] = await ctx.tx
              .select()
              .from(schema.segmentMemberships)
              .where(and(eq(schema.segmentMemberships.segmentId, n.segment), eq(schema.segmentMemberships.profileId, input.profileId)));
            return !!m;
          }
          return (await evaluate(n.condition!, contextFor(ctx.tx, ws, ctx.services.events, segments, { scope: [input.profileId] }))).has(
            input.profileId,
          );
        },
      });
      const effects = new Map(out.effects.map((e) => [`${e.node}:${e.seq}`, e]));
      for (const s of out.steps) {
        const node = graph.nodes.get(s.node)!;
        let detail = s.detail || s.type;
        const eff = effects.get(`${s.node}:${s.seq}`);
        if (eff?.kind === 'email') {
          if (input.profileId) {
            const [tpl] = await ctx.tx
              .select({ purpose: sql<string>`${schema.artifactVersions.content} ->> 'purpose'` })
              .from(schema.artifacts)
              .innerJoin(
                schema.artifactVersions,
                and(
                  eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
                  eq(schema.artifactVersions.artifactId, schema.artifacts.id),
                  eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
                ),
              )
              .where(eq(schema.artifacts.id, eff.template));
            const v = tpl
              ? await checkRecipient(ctx.tx, ws, ctx.services.keyProvider, input.profileId, tpl.purpose)
              : { ok: false as const, reason: 'not_published: the template has no published version' };
            detail = v.ok ? `would send ${eff.template}` : `would not send: ${v.reason}`;
          } else detail = `would send ${eff.template}`;
        } else if (eff?.kind === 'updateProfile') detail = `would set ${eff.trait} = ${JSON.stringify(eff.value)}`;
        if (s.type === 'step' || s.type === 'converted')
          steps.push({ after: fmt(clock), node: s.node, label: node.label, kind: node.kind, detail });
      }
      state = out.state;
      if (state.status !== 'waiting') break;
      // Jump the clock to the next scripted event the person waits for, or the timer.
      const next = scripted.find((e) => e.at >= clock && e.event === state.waitingEvent && e.at <= (state.dueAt?.getTime() ?? Infinity));
      clock = next ? next.at : (state.dueAt?.getTime() ?? limit);
      if (clock > limit) break;
      state = { ...state, matched: !!next, waitingEvent: null };
      if (next) scripted.splice(scripted.indexOf(next), 1);
    }
    const outcome: 'completed' | 'exited' | 'waiting' =
      state.status === 'completed' || state.status === 'exited' ? state.status : 'waiting';
    return { version, outcome, converted: state.converted, steps };
  },
});

export const journeyCommands = [journeyStats, enrollProfiles, simulateJourney] as const;
