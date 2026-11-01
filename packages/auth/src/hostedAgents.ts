import { personalDataInText } from '@agentic-marketing/ai';
import { type CommandContext, defineCommand, PERMISSIONS, type Permission, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Role, schema } from '@agentic-marketing/db';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AGENT_EVENT_TYPES } from './agentEvents';
import { describeHostedSchedule, isValidHostedSchedule, nextHostedRunAt } from './hostedSchedule';

// Hosted agents (#258, #86): an agent the platform runs itself on a schedule, under the agent's
// mandate like any other. People create, change, delete and run them; their runs are read-only for
// anyone who may read artifacts. The scheduler in apps/server executes them.

const AGENT_ID = z.string().regex(/^agt_[0-9a-f]{32}$/, 'An agent id looks like agt_…');
const ProviderId = z.string().regex(/^aip_[0-9a-f]{32}$/, 'An AI provider id looks like aip_…');
const SkillId = z.string().regex(/^skl_[0-9a-f]{32}$/, 'A skill artifact id looks like skl_…');
const Skills = z.array(SkillId).max(20).default([]).describe('Skill artifact ids (skl_…); only their published versions are used in a run');
const Schedule = z
  .string()
  .min(1)
  .max(80)
  .refine(isValidHostedSchedule, 'Use hourly, daily:HH:MM or weekly:day:HH:MM (e.g. weekly:mon:07:00).');

const Budgets = z.object({
  maxTokensPerRun: z.number().int().min(100).max(1_000_000).default(20_000),
  maxToolCallsPerRun: z.number().int().min(1).max(100).default(20),
});

/** Events that start a run (#338), on top of the schedule; limits keep event runs bounded. */
const Triggers = z.object({
  triggers: z
    .array(z.enum(AGENT_EVENT_TYPES))
    .max(AGENT_EVENT_TYPES.length)
    .describe('Agent event types that start a run, e.g. guardrail.breach or experiment.significant; empty: schedule only'),
  triggerFilter: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .describe('Only events whose subject matches, e.g. {"journeyId":"jrn_…"}, like agents.subscribe'),
  eventMinGapMinutes: z.number().int().min(5).max(1440).describe('Minimum time between two event runs'),
  eventRunsPerDay: z.number().int().min(1).max(48).describe('Most event runs in 24 hours'),
});

const HostedAgent = z.object({
  agentId: z.string(),
  name: z.string(),
  description: z.string(),
  sponsor: z.object({ id: z.string(), name: z.string() }),
  instructions: z.string(),
  schedule: z.string(),
  scheduleText: z.string().describe('The schedule in words, in the workspace time zone'),
  timeZone: z.string().describe('The workspace time zone the schedule is read in'),
  scopes: z.array(z.string()),
  enabled: z.boolean(),
  budgets: z.object({ maxTokensPerRun: z.number().int(), maxToolCallsPerRun: z.number().int() }),
  ...Triggers.shape,
  skills: z.array(z.string()).describe('Skill artifact ids whose published versions are in each run’s context'),
  modelProviderId: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  running: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type HostedAgent = z.infer<typeof HostedAgent>;

const HostedRun = z.object({
  id: z.string(),
  agentId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(['ok', 'failed', 'skipped']),
  summary: z.string(),
  toolCalls: z.number().int(),
  tokens: z.number().int(),
  error: z.string().nullable(),
  trigger: z.enum(['schedule', 'event']).describe('What started the run'),
  eventIds: z.array(z.number().int()).describe('The agent events an event run handled (agents.events)'),
});
async function loadHostedAgent(ctx: CommandContext, agentId: string): Promise<HostedAgent | null> {
  const { tx } = ctx;
  const [row] = await tx
    .select({ hosted: schema.hostedAgents, agent: schema.agents })
    .from(schema.hostedAgents)
    .innerJoin(
      schema.agents,
      and(eq(schema.agents.workspaceId, schema.hostedAgents.workspaceId), eq(schema.agents.id, schema.hostedAgents.agentId)),
    )
    .where(eq(schema.hostedAgents.agentId, agentId));
  if (!row) return null;
  const [w] = await tx.select({ timeZone: schema.workspaces.timeZone }).from(schema.workspaces);
  const person = (await ctx.services.directory.users([row.agent.sponsorUserId])).get(row.agent.sponsorUserId);
  return {
    agentId: row.agent.id,
    name: row.agent.name,
    description: row.agent.description,
    sponsor: { id: row.agent.sponsorUserId, name: person?.name || person?.email || row.agent.sponsorUserId },
    instructions: row.hosted.instructions,
    schedule: row.hosted.schedule,
    scheduleText: describeHostedSchedule(row.hosted.schedule),
    timeZone: w?.timeZone ?? 'UTC',
    scopes: row.hosted.scopes,
    enabled: row.hosted.enabled,
    budgets: { maxTokensPerRun: row.hosted.maxTokensPerRun, maxToolCallsPerRun: row.hosted.maxToolCallsPerRun },
    triggers: row.hosted.triggers,
    triggerFilter: row.hosted.triggerFilter,
    eventMinGapMinutes: row.hosted.eventMinGapMinutes,
    eventRunsPerDay: row.hosted.eventRunsPerDay,
    skills: row.hosted.skills,
    modelProviderId: row.hosted.modelProviderId,
    consecutiveFailures: row.hosted.consecutiveFailures,
    lastRunAt: row.hosted.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.hosted.nextRunAt?.toISOString() ?? null,
    running: row.hosted.runningRunId !== null,
    createdAt: row.hosted.createdAt.toISOString(),
    updatedAt: row.hosted.updatedAt.toISOString(),
  };
}

/**
 * Keeps the agent subscription that records a hosted agent's trigger events (#312, #338) in step
 * with its triggers: created or updated when it has some, removed when it has none.
 */
async function syncTriggerSubscription(
  ctx: CommandContext,
  agentId: string,
  current: string | null,
  triggers: string[],
  filter: Record<string, string | string[]>,
): Promise<string | null> {
  if (!triggers.length) {
    if (current) await ctx.tx.delete(schema.agentSubscriptions).where(eq(schema.agentSubscriptions.id, current));
    return null;
  }
  const eventTypes = triggers as (typeof AGENT_EVENT_TYPES)[number][];
  if (current) {
    const updated = await ctx.tx
      .update(schema.agentSubscriptions)
      .set({ eventTypes, filter })
      .where(eq(schema.agentSubscriptions.id, current))
      .returning({ id: schema.agentSubscriptions.id });
    if (updated.length) return current;
  }
  const id = newId('sub');
  await ctx.tx.insert(schema.agentSubscriptions).values({ workspaceId: ctx.principal.workspaceId, id, agentId, eventTypes, filter });
  return id;
}

function assertEditorScopes(role: Role, scopes: string[]) {
  const allowed = ROLE_PERMISSIONS[role];
  const extra = scopes.filter((s) => !allowed.includes(s as Permission));
  if (extra.length) throw new AppError('forbidden', `Your role (${role}) cannot grant ${extra.join(', ')} to a hosted agent.`);
}

/** The workspace's time zone; the hosted agent schedules are read in it. */
async function workspaceTimeZone(ctx: CommandContext): Promise<string> {
  const [w] = await ctx.tx.select({ timeZone: schema.workspaces.timeZone }).from(schema.workspaces);
  return w?.timeZone ?? 'UTC';
}

async function assertProvider(tx: CommandContext['tx'], id: string | null | undefined) {
  if (!id) return;
  const [p] = await tx
    .select({ id: schema.aiProviders.id, enabled: schema.aiProviders.enabled })
    .from(schema.aiProviders)
    .where(eq(schema.aiProviders.id, id));
  if (!p) throw new AppError('invalid_input', `No AI provider ${id}. List them with aiProviders.list.`);
  if (!p.enabled) throw new AppError('invalid_input', `The AI provider ${id} is disabled. Enable it or choose another.`);
}

/** Referenced skills must be skill artifacts; a draft is allowed and is used once it is published. */
async function assertSkills(tx: CommandContext['tx'], ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const rows = await tx
    .select({ id: schema.artifacts.id, type: schema.artifacts.type })
    .from(schema.artifacts)
    .where(inArray(schema.artifacts.id, unique));
  for (const id of unique) {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new AppError('invalid_input', `No artifact ${id}. Create a skill with artifacts.create {type:"skill"} first.`);
    if (row.type !== 'skill') throw new AppError('invalid_input', `${id} is a ${row.type}, not a skill.`);
  }
  return unique;
}

export const createHostedAgent = defineCommand({
  name: 'agents.createHosted',
  title: 'Create a hosted agent',
  description:
    'Create an agent the platform runs itself on a schedule in the workspace time zone. Give it instructions, the permissions it may use and budgets per run; its runs act as the agent under its mandate, so writes still pass the policy engine. The schedule is hourly, daily:HH:MM or weekly:day:HH:MM (e.g. weekly:mon:07:00). People only.',
  input: z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).default(''),
    instructions: z.string().min(1).max(8000).describe('What the agent should do on each run; it is the run’s prompt'),
    schedule: Schedule,
    scopes: z.array(z.enum(PERMISSIONS)).min(1).max(13).describe('Permissions for the run, never more than your role'),
    ...Budgets.shape,
    triggers: Triggers.shape.triggers.default([]),
    triggerFilter: Triggers.shape.triggerFilter.default({}),
    eventMinGapMinutes: Triggers.shape.eventMinGapMinutes.default(30),
    eventRunsPerDay: Triggers.shape.eventRunsPerDay.default(6),
    skills: Skills,
    modelProviderId: ProviderId.optional().describe('An AI provider to use instead of the copilot provider'),
    enabled: z.boolean().default(true),
  }),
  output: HostedAgent,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.name,
  handler: async (input, ctx) => {
    assertEditorScopes(ctx.principal.role, input.scopes);
    await assertProvider(ctx.tx, input.modelProviderId);
    const skills = await assertSkills(ctx.tx, input.skills);
    const timeZone = await workspaceTimeZone(ctx);
    const agentId = newId('agt');
    const now = new Date();
    await ctx.tx.insert(schema.agents).values({
      workspaceId: ctx.principal.workspaceId,
      id: agentId,
      name: input.name,
      description: input.description,
      sponsorUserId: ctx.principal.userId,
    });
    await ctx.tx.insert(schema.agentCredentials).values({
      workspaceId: ctx.principal.workspaceId,
      kind: 'hosted',
      credentialId: agentId,
      agentId,
    });
    await ctx.tx.insert(schema.hostedAgents).values({
      workspaceId: ctx.principal.workspaceId,
      agentId,
      instructions: input.instructions,
      schedule: input.schedule.trim().toLowerCase(),
      scopes: [...new Set(input.scopes)],
      enabled: input.enabled,
      maxTokensPerRun: input.maxTokensPerRun,
      maxToolCallsPerRun: input.maxToolCallsPerRun,
      modelProviderId: input.modelProviderId ?? null,
      nextRunAt: input.enabled ? nextHostedRunAt(input.schedule, timeZone, now) : null,
      triggers: [...new Set(input.triggers)],
      triggerFilter: input.triggerFilter,
      eventMinGapMinutes: input.eventMinGapMinutes,
      eventRunsPerDay: input.eventRunsPerDay,
      skills,
      triggerSubscriptionId: await syncTriggerSubscription(ctx, agentId, null, [...new Set(input.triggers)], input.triggerFilter),
      updatedAt: now,
    });
    const out = await loadHostedAgent(ctx, agentId);
    if (!out) throw new Error('the hosted agent was not created');
    return out;
  },
});

export const updateHostedAgent = defineCommand({
  name: 'agents.updateHosted',
  title: 'Change a hosted agent',
  description:
    'Change a hosted agent’s name, instructions, schedule, permissions, budgets, model or whether it is enabled. A new schedule takes effect from its next matching time; disabling it stops future runs without deleting its history. People only.',
  input: z.object({
    agentId: AGENT_ID,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    instructions: z.string().min(1).max(8000).optional(),
    schedule: Schedule.optional(),
    scopes: z.array(z.enum(PERMISSIONS)).min(1).max(13).optional(),
    maxTokensPerRun: z.number().int().min(100).max(1_000_000).optional(),
    maxToolCallsPerRun: z.number().int().min(1).max(100).optional(),
    modelProviderId: ProviderId.nullable().optional(),
    enabled: z.boolean().optional(),
    triggers: Triggers.shape.triggers.optional(),
    triggerFilter: Triggers.shape.triggerFilter.optional(),
    eventMinGapMinutes: Triggers.shape.eventMinGapMinutes.optional(),
    eventRunsPerDay: Triggers.shape.eventRunsPerDay.optional(),
    skills: z.array(SkillId).max(20).optional().describe('Skill artifact ids; replaces the list, empty clears it'),
  }),
  output: HostedAgent,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const [current] = await ctx.tx
      .select({ hosted: schema.hostedAgents, agent: schema.agents })
      .from(schema.hostedAgents)
      .innerJoin(
        schema.agents,
        and(eq(schema.agents.workspaceId, schema.hostedAgents.workspaceId), eq(schema.agents.id, schema.hostedAgents.agentId)),
      )
      .where(eq(schema.hostedAgents.agentId, input.agentId));
    if (!current) throw new AppError('not_found', `No hosted agent ${input.agentId}.`);
    if (input.scopes) assertEditorScopes(ctx.principal.role, input.scopes);
    if (input.modelProviderId !== undefined) await assertProvider(ctx.tx, input.modelProviderId);
    const skills = input.skills !== undefined ? await assertSkills(ctx.tx, input.skills) : undefined;
    const timeZone = await workspaceTimeZone(ctx);
    const now = new Date();
    const schedule = input.schedule?.trim().toLowerCase() ?? current.hosted.schedule;
    const enabled = input.enabled ?? current.hosted.enabled;
    const scheduleChanged = schedule !== current.hosted.schedule || enabled !== current.hosted.enabled;
    if (input.name !== undefined || input.description !== undefined)
      await ctx.tx
        .update(schema.agents)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: now,
        })
        .where(eq(schema.agents.id, input.agentId));
    await ctx.tx
      .update(schema.hostedAgents)
      .set({
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.scopes ? { scopes: [...new Set(input.scopes)] } : {}),
        ...(input.maxTokensPerRun !== undefined ? { maxTokensPerRun: input.maxTokensPerRun } : {}),
        ...(input.maxToolCallsPerRun !== undefined ? { maxToolCallsPerRun: input.maxToolCallsPerRun } : {}),
        ...(input.modelProviderId !== undefined ? { modelProviderId: input.modelProviderId } : {}),
        ...(input.eventMinGapMinutes !== undefined ? { eventMinGapMinutes: input.eventMinGapMinutes } : {}),
        ...(input.eventRunsPerDay !== undefined ? { eventRunsPerDay: input.eventRunsPerDay } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(input.triggers !== undefined || input.triggerFilter !== undefined
          ? await (async () => {
              const triggers = [...new Set(input.triggers ?? current.hosted.triggers)];
              const triggerFilter = input.triggerFilter ?? current.hosted.triggerFilter;
              const triggerSubscriptionId = await syncTriggerSubscription(
                ctx,
                input.agentId,
                current.hosted.triggerSubscriptionId,
                triggers,
                triggerFilter,
              );
              return { triggers, triggerFilter, triggerSubscriptionId };
            })()
          : {}),
        schedule,
        enabled,
        ...(scheduleChanged && !enabled ? { nextRunAt: null } : {}),
        ...(scheduleChanged && enabled ? { nextRunAt: nextHostedRunAt(schedule, timeZone, now) } : {}),
        updatedAt: now,
      })
      .where(eq(schema.hostedAgents.agentId, input.agentId));
    const out = await loadHostedAgent(ctx, input.agentId);
    if (!out) throw new Error('the hosted agent disappeared');
    return out;
  },
});

export const deleteHostedAgent = defineCommand({
  name: 'agents.deleteHosted',
  title: 'Delete a hosted agent',
  description:
    'Delete a hosted agent and its run history. The agent’s ledger entries stay, so what it did remains auditable. Refused while a run is going. People only.',
  input: z.object({ agentId: AGENT_ID }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const [hosted] = await ctx.tx
      .select({ runningRunId: schema.hostedAgents.runningRunId })
      .from(schema.hostedAgents)
      .where(eq(schema.hostedAgents.agentId, input.agentId));
    if (!hosted) throw new AppError('not_found', `No hosted agent ${input.agentId}.`);
    if (hosted.runningRunId) throw new AppError('conflict', 'A run is going; wait for it to finish before deleting this hosted agent.');
    const done = await ctx.tx.delete(schema.agents).where(eq(schema.agents.id, input.agentId)).returning({ id: schema.agents.id });
    if (!done.length) throw new AppError('not_found', `No agent ${input.agentId}.`);
    return { deleted: true as const };
  },
});

export const runHostedAgentNow = defineCommand({
  name: 'agents.runHostedNow',
  title: 'Run a hosted agent now',
  description:
    'Start a hosted agent’s next run at the scheduler’s next tick without changing its schedule. Refused when it is disabled; enable it first. People only.',
  input: z.object({ agentId: AGENT_ID }),
  output: HostedAgent,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx
      .select({ hosted: schema.hostedAgents, status: schema.agents.status })
      .from(schema.hostedAgents)
      .innerJoin(
        schema.agents,
        and(eq(schema.agents.workspaceId, schema.hostedAgents.workspaceId), eq(schema.agents.id, schema.hostedAgents.agentId)),
      )
      .where(eq(schema.hostedAgents.agentId, input.agentId));
    if (!row) throw new AppError('not_found', `No hosted agent ${input.agentId}.`);
    if (row.status !== 'active') throw new AppError('conflict', 'This agent is not active. Resume it under Settings → Agents first.');
    if (!row.hosted.enabled) throw new AppError('conflict', 'This hosted agent is disabled. Enable it before running it now.');
    await ctx.tx
      .update(schema.hostedAgents)
      .set({ nextRunAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.hostedAgents.agentId, input.agentId));
    const out = await loadHostedAgent(ctx, input.agentId);
    if (!out) throw new Error('the hosted agent disappeared');
    return out;
  },
});

export const hostedAgentRuns = defineCommand({
  name: 'agents.hostedRuns',
  title: 'A hosted agent and its runs',
  description:
    'The hosted agent’s schedule, time zone, budgets, enabled state and next run, with its recent runs newest first: status (ok, failed, skipped), summary, tool calls, tokens and error. `hosted` is null for an agent the platform does not run.',
  input: z.object({
    agentId: AGENT_ID,
    limit: z.number().int().min(1).max(100).default(30),
    before: z.string().datetime().optional().describe('Return runs that started before this time (the previous page’s `next`)'),
  }),
  output: z.object({
    hosted: HostedAgent.nullable(),
    runs: z.array(HostedRun),
    next: z.string().nullable(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const hosted = await loadHostedAgent(ctx, input.agentId);
    if (!hosted) return { hosted: null, runs: [], next: null };
    const rows = await ctx.tx
      .select()
      .from(schema.hostedAgentRuns)
      .where(
        and(
          eq(schema.hostedAgentRuns.agentId, input.agentId),
          input.before ? lt(schema.hostedAgentRuns.startedAt, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(schema.hostedAgentRuns.startedAt))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return {
      hosted,
      runs: page.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        status: r.status,
        summary: r.summary,
        toolCalls: r.toolCalls,
        tokens: r.tokens,
        error: r.error,
        trigger: r.trigger,
        eventIds: r.eventIds,
      })),
      next: rows.length > input.limit ? (page.at(-1)?.startedAt.toISOString() ?? null) : null,
    };
  },
});

/** A hosted agent's own notes (#340): bounded, inspectable and free of personal data. */
const MEMORY_MAX_NOTES = 50;
const MEMORY_MAX_CHARS = 10_000;
const MemoryText = z.string().trim().min(1).max(1_000).describe('One note, at most 1,000 characters; no personal data');

const MemoryNote = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  createdBy: z.object({ type: z.enum(['run', 'person']), id: z.string() }).describe('The run or the person that wrote it'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type MemoryNote = z.infer<typeof MemoryNote>;

const toMemoryNote = (row: typeof schema.hostedAgentMemory.$inferSelect): MemoryNote => ({
  id: row.id,
  agentId: row.agentId,
  text: row.text,
  createdBy: row.createdByRunId ? { type: 'run', id: row.createdByRunId } : { type: 'person', id: row.createdByUserId ?? '' },
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The hosted agent behind a memory call; 404 for an agent the platform does not run. */
async function assertHostedForMemory(ctx: CommandContext, agentId: string) {
  const [row] = await ctx.tx
    .select({ agentId: schema.hostedAgents.agentId })
    .from(schema.hostedAgents)
    .where(eq(schema.hostedAgents.agentId, agentId));
  if (!row) throw new AppError('not_found', `No hosted agent ${agentId}.`);
}

/** An agent principal may only touch its own memory; people may inspect any hosted agent's. */
function assertMemoryScope(ctx: CommandContext, agentId: string) {
  if (ctx.principal.type === 'agent' && ctx.principal.agent?.id !== agentId)
    throw new AppError('forbidden', 'An agent can only read and change its own memory.');
}

function assertNoPersonalData(text: string) {
  const found = personalDataInText(text);
  if (found.length)
    throw new AppError(
      'invalid_input',
      `Memory notes must not hold personal data (found ${found.join(', ')}). Note what to do, not who it is about.`,
    );
}

async function memoryUsage(ctx: CommandContext, agentId: string) {
  const [row] = await ctx.tx
    .select({
      notes: sql<number>`count(*)::int`,
      characters: sql<number>`coalesce(sum(char_length(${schema.hostedAgentMemory.text})), 0)::int`,
    })
    .from(schema.hostedAgentMemory)
    .where(eq(schema.hostedAgentMemory.agentId, agentId));
  return { notes: Number(row?.notes ?? 0), characters: Number(row?.characters ?? 0) };
}

export const listHostedMemory = defineCommand({
  name: 'agents.memory.list',
  title: 'List a hosted agent’s memory',
  description:
    'The working notes a hosted agent keeps for itself, newest first. People may read any hosted agent’s; an agent may read only its own. Memory is capped at 50 notes and 10,000 characters per agent and is separate from learnings, which need evidence.',
  input: z.object({
    agentId: AGENT_ID,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    notes: z.array(MemoryNote),
    count: z.number().int(),
    characters: z.number().int(),
    limits: z.object({ notes: z.number().int(), characters: z.number().int() }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    await assertHostedForMemory(ctx, input.agentId);
    assertMemoryScope(ctx, input.agentId);
    const rows = await ctx.tx
      .select()
      .from(schema.hostedAgentMemory)
      .where(eq(schema.hostedAgentMemory.agentId, input.agentId))
      .orderBy(desc(schema.hostedAgentMemory.createdAt))
      .limit(input.limit);
    const usage = await memoryUsage(ctx, input.agentId);
    return {
      notes: rows.map(toMemoryNote),
      count: usage.notes,
      characters: usage.characters,
      limits: { notes: MEMORY_MAX_NOTES, characters: MEMORY_MAX_CHARS },
    };
  },
});

export const addHostedMemory = defineCommand({
  name: 'agents.memory.add',
  title: 'Add a memory note',
  description:
    'Write one working note for a hosted agent: at most 1,000 characters, no personal data (e-mail addresses and phone numbers are refused). A hosted agent may add to its own memory during a run; people may add to any hosted agent’s. The memory holds at most 50 notes and 10,000 characters per agent, so delete stale notes first.',
  input: z.object({ agentId: AGENT_ID, text: MemoryText }),
  output: MemoryNote,
  permission: 'artifacts:read',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    await assertHostedForMemory(ctx, input.agentId);
    assertMemoryScope(ctx, input.agentId);
    assertNoPersonalData(input.text);
    const { notes, characters } = await memoryUsage(ctx, input.agentId);
    if (notes >= MEMORY_MAX_NOTES)
      throw new AppError(
        'conflict',
        `This agent already has ${MEMORY_MAX_NOTES} memory notes, the maximum. Delete a stale note with agents.memory.delete before adding another.`,
      );
    if (characters + input.text.length > MEMORY_MAX_CHARS)
      throw new AppError(
        'conflict',
        `This note would take the agent past ${MEMORY_MAX_CHARS.toLocaleString('en-US')} characters of memory. Delete a stale note with agents.memory.delete before adding another.`,
      );
    let createdByRunId: string | null = null;
    if (ctx.principal.type === 'agent') {
      const [hosted] = await ctx.tx
        .select({ runningRunId: schema.hostedAgents.runningRunId })
        .from(schema.hostedAgents)
        .where(eq(schema.hostedAgents.agentId, input.agentId));
      createdByRunId = hosted?.runningRunId ?? null;
      if (!createdByRunId) throw new AppError('conflict', 'A hosted agent writes memory during a run; none is going for this agent.');
    }
    const [created] = await ctx.tx
      .insert(schema.hostedAgentMemory)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('hmm'),
        agentId: input.agentId,
        text: input.text,
        createdByRunId,
        createdByUserId: createdByRunId ? null : ctx.principal.userId,
      })
      .returning();
    return toMemoryNote(created);
  },
});

export const updateHostedMemory = defineCommand({
  name: 'agents.memory.update',
  title: 'Edit a memory note',
  description:
    'Replace the text of one memory note. People only: the agent may write and delete its own notes, but not rewrite them after the fact. The same 1,000-character limit and personal-data check apply.',
  input: z.object({ id: z.string().regex(/^hmm_[0-9a-f]{32}$/, 'A memory note id looks like hmm_…'), text: MemoryText }),
  output: MemoryNote,
  permission: 'artifacts:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'draft',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.select().from(schema.hostedAgentMemory).where(eq(schema.hostedAgentMemory.id, input.id));
    if (!row) throw new AppError('not_found', `No memory note ${input.id}.`);
    assertNoPersonalData(input.text);
    const { characters } = await memoryUsage(ctx, row.agentId);
    if (characters - row.text.length + input.text.length > MEMORY_MAX_CHARS)
      throw new AppError(
        'conflict',
        `This edit would take the agent past ${MEMORY_MAX_CHARS.toLocaleString('en-US')} characters of memory. Delete a stale note first.`,
      );
    const [updated] = await ctx.tx
      .update(schema.hostedAgentMemory)
      .set({ text: input.text, updatedAt: new Date() })
      .where(eq(schema.hostedAgentMemory.id, input.id))
      .returning();
    return toMemoryNote(updated);
  },
});

export const deleteHostedMemory = defineCommand({
  name: 'agents.memory.delete',
  title: 'Delete a memory note',
  description:
    'Delete one memory note. People may delete any note of a hosted agent; the agent may delete its own (to make room under the cap). The note is removed for good.',
  input: z.object({ id: z.string().regex(/^hmm_[0-9a-f]{32}$/, 'A memory note id looks like hmm_…') }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'artifacts:read',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.select().from(schema.hostedAgentMemory).where(eq(schema.hostedAgentMemory.id, input.id));
    if (!row) throw new AppError('not_found', `No memory note ${input.id}.`);
    assertMemoryScope(ctx, row.agentId);
    await ctx.tx.delete(schema.hostedAgentMemory).where(eq(schema.hostedAgentMemory.id, input.id));
    return { deleted: true as const };
  },
});

export const hostedAgentCommands = [
  createHostedAgent,
  updateHostedAgent,
  deleteHostedAgent,
  runHostedAgentNow,
  hostedAgentRuns,
  listHostedMemory,
  addHostedMemory,
  updateHostedMemory,
  deleteHostedMemory,
];
