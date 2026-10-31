import { type CommandContext, defineCommand, PERMISSIONS, type Permission, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Role, schema } from '@agentic-marketing/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { describeHostedSchedule, isValidHostedSchedule, nextHostedRunAt } from './hostedSchedule';

// Hosted agents (#258, #86): an agent the platform runs itself on a schedule, under the agent's
// mandate like any other. People create, change, delete and run them; their runs are read-only for
// anyone who may read artifacts. The scheduler in apps/server executes them.

const AGENT_ID = z.string().regex(/^agt_[0-9a-f]{32}$/, 'An agent id looks like agt_…');
const ProviderId = z.string().regex(/^aip_[0-9a-f]{32}$/, 'An AI provider id looks like aip_…');
const Schedule = z
  .string()
  .min(1)
  .max(80)
  .refine(isValidHostedSchedule, 'Use hourly, daily:HH:MM or weekly:day:HH:MM (e.g. weekly:mon:07:00).');

const Budgets = z.object({
  maxTokensPerRun: z.number().int().min(100).max(1_000_000).default(20_000),
  maxToolCallsPerRun: z.number().int().min(1).max(100).default(20),
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
    modelProviderId: row.hosted.modelProviderId,
    consecutiveFailures: row.hosted.consecutiveFailures,
    lastRunAt: row.hosted.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.hosted.nextRunAt?.toISOString() ?? null,
    running: row.hosted.runningRunId !== null,
    createdAt: row.hosted.createdAt.toISOString(),
    updatedAt: row.hosted.updatedAt.toISOString(),
  };
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
      })),
      next: rows.length > input.limit ? (page.at(-1)?.startedAt.toISOString() ?? null) : null,
    };
  },
});

export const hostedAgentCommands = [createHostedAgent, updateHostedAgent, deleteHostedAgent, runHostedAgentNow, hostedAgentRuns];
