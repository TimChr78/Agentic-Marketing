import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type AlertChannel, schema, type Tx } from '@agentic-marketing/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AlertDirectory, NotifyDeps } from './deps';
import { notifyChannels } from './notify';
import {
  AlertChannels,
  type AlertConfig,
  AlertKindSchema,
  type DeliverabilityConfig,
  type JourneyErrorsConfig,
  parseAlertConfig,
  type SignupDropConfig,
} from './rules';

// Alerts are configuration plus history. They use the same permission as setting up a webhook
// endpoint (workspace:admin), and the same command surface agents get over MCP.

const RuleId = z.string().regex(/^alr_[0-9a-f]{32}$/, 'An alert rule id (alr_…)');

const ConfigOutput = z.record(z.string(), z.unknown());
const ChannelOutput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), webhookId: z.string() }),
  z.object({ type: z.literal('email'), userIds: z.array(z.string()) }),
]);

const Rule = z.object({
  id: z.string(),
  name: z.string(),
  kind: AlertKindSchema,
  config: ConfigOutput,
  channels: z.array(ChannelOutput),
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: z.enum(['ok', 'firing']),
  firingSince: z.string().nullable(),
});
type RuleOut = z.infer<typeof Rule>;

const Event = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  state: z.enum(['firing', 'resolved']),
  value: z.number(),
  threshold: z.number(),
  window: z.string(),
  firedAt: z.string(),
  resolvedAt: z.string().nullable(),
  notified: z.array(z.record(z.string(), z.unknown())),
});

type RuleRow = typeof schema.alertRules.$inferSelect;
type EventRow = typeof schema.alertEvents.$inferSelect;

function ruleOut(rule: RuleRow, open?: EventRow | null): RuleOut {
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    config: rule.config,
    channels: rule.channels,
    enabled: rule.enabled,
    createdBy: rule.createdBy,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    state: open ? 'firing' : 'ok',
    firingSince: open ? open.firedAt.toISOString() : null,
  };
}

function eventOut(event: EventRow, ruleName: string) {
  return {
    id: event.id,
    ruleId: event.ruleId,
    ruleName,
    state: event.state,
    value: event.value,
    threshold: event.threshold,
    window: event.window,
    firedAt: event.firedAt.toISOString(),
    resolvedAt: event.resolvedAt?.toISOString() ?? null,
    notified: event.notified as Record<string, unknown>[],
  };
}

async function loadRule(tx: Tx, id: string): Promise<RuleRow> {
  const [rule] = await tx.select().from(schema.alertRules).where(eq(schema.alertRules.id, id));
  if (!rule) throw new AppError('not_found', `No alert rule ${id}. List them with alerts.list.`);
  return rule;
}

async function checkChannels(tx: Tx, workspaceId: string, channels: AlertChannel[]) {
  const webhookIds = channels.flatMap((c) => (c.type === 'webhook' ? [c.webhookId] : []));
  if (webhookIds.length) {
    const rows = await tx
      .select({ id: schema.webhookEndpoints.id })
      .from(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.workspaceId, workspaceId), inArray(schema.webhookEndpoints.id, webhookIds)));
    const found = new Set(rows.map((r) => r.id));
    const missing = webhookIds.filter((id) => !found.has(id));
    if (missing.length)
      throw new AppError(
        'invalid_input',
        `No webhook endpoint ${missing[0]} in this workspace. Create one with webhooks.create or pick another channel.`,
      );
  }
  const userIds = [...new Set(channels.flatMap((c) => (c.type === 'email' ? c.userIds : [])))];
  if (userIds.length) {
    const rows = await tx
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), inArray(schema.workspaceMembers.userId, userIds)));
    const found = new Set(rows.map((r) => r.userId));
    const missing = userIds.filter((id) => !found.has(id));
    if (missing.length)
      throw new AppError('invalid_input', `${missing[0]} is not a member of this workspace, so an alert cannot e-mail them.`);
  }
}

function notifyDeps(ctx: CommandContext): NotifyDeps {
  return {
    kp: ctx.services.keyProvider,
    email: ctx.services.email,
    // Auth augments Services with the directory; cast structurally so alerts need not depend on it.
    directory: (ctx.services as { directory?: AlertDirectory }).directory ?? { users: async () => new Map() },
    publicUrl: ctx.services.publicUrl ?? ctx.services.linksUrl ?? '',
  };
}

export const listAlerts = defineCommand({
  name: 'alerts.list',
  title: 'List alert rules',
  description:
    'Threshold rules over the analytics metric layer, with their channels and whether each is currently firing (and since when). Rules are workspace-scoped; history is in alerts.history.',
  input: z.object({}),
  output: z.object({ rules: z.array(Rule) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const rules = await ctx.tx.select().from(schema.alertRules).orderBy(desc(schema.alertRules.createdAt));
    const open = await ctx.tx.select().from(schema.alertEvents).where(isNull(schema.alertEvents.resolvedAt));
    const byRule = new Map(open.map((e) => [e.ruleId, e]));
    return { rules: rules.map((r) => ruleOut(r, byRule.get(r.id))) };
  },
});

export const getAlert = defineCommand({
  name: 'alerts.get',
  title: 'Get an alert rule',
  description:
    'One alert rule with its kind-specific configuration, channels and the open firing event, if any. Values and thresholds are fractions for rates and counts for counts.',
  input: z.object({ id: RuleId }),
  output: z.object({ rule: Rule, openEvent: Event.nullable() }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const rule = await loadRule(ctx.tx, input.id);
    const [open] = await ctx.tx
      .select()
      .from(schema.alertEvents)
      .where(and(eq(schema.alertEvents.ruleId, rule.id), isNull(schema.alertEvents.resolvedAt)))
      .limit(1);
    return { rule: ruleOut(rule, open), openEvent: open ? eventOut(open, rule.name) : null };
  },
});

export const createAlert = defineCommand({
  name: 'alerts.create',
  title: 'Create an alert rule',
  description:
    'Watch a metric and notify when it crosses a threshold. Kinds: deliverability (bounce or complaint rate over a window, above a fraction, with a minimum number of sends), signup_drop (confirmed signups below a percentage of the previous window), journey_errors (failed journey steps above a count). Channels are existing webhook endpoints (whk_…) and/or workspace members by user id; e-mail carries aggregates only. Writes need workspace:admin, the same permission as configuring webhooks.',
  input: z.object({
    name: z.string().min(1).max(120),
    kind: AlertKindSchema,
    config: ConfigOutput.default({}),
    channels: AlertChannels,
    enabled: z.boolean().default(true),
  }),
  output: z.object({ rule: Rule }),
  permission: 'workspace:admin',
  effect: 'write',
  handler: async (input, ctx) => {
    const workspaceId = ctx.principal.workspaceId;
    const config = parseAlertConfig(input.kind, input.config);
    await checkChannels(ctx.tx, workspaceId, input.channels);
    const [row] = await ctx.tx
      .insert(schema.alertRules)
      .values({
        workspaceId,
        id: newId('alr'),
        name: input.name,
        kind: input.kind,
        config: config as unknown as Record<string, unknown>,
        channels: input.channels,
        enabled: input.enabled,
        createdBy: ctx.principal.userId,
      })
      .returning();
    return { rule: ruleOut(row) };
  },
});

export const updateAlert = defineCommand({
  name: 'alerts.update',
  title: 'Change an alert rule',
  description:
    'Change a rule’s name, configuration, channels or enabled state. The kind is fixed; update the configuration to match it. Turning a rule off stops evaluation but keeps its history.',
  input: z.object({
    id: RuleId,
    name: z.string().min(1).max(120).optional(),
    config: ConfigOutput.optional(),
    channels: AlertChannels.optional(),
    enabled: z.boolean().optional(),
  }),
  output: z.object({ rule: Rule }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const existing = await loadRule(ctx.tx, input.id);
    const config =
      input.config === undefined ? existing.config : (parseAlertConfig(existing.kind, input.config) as unknown as Record<string, unknown>);
    if (input.channels) await checkChannels(ctx.tx, ctx.principal.workspaceId, input.channels);
    const [row] = await ctx.tx
      .update(schema.alertRules)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.config === undefined ? {} : { config }),
        ...(input.channels === undefined ? {} : { channels: input.channels }),
        updatedAt: new Date(),
      })
      .where(eq(schema.alertRules.id, input.id))
      .returning();
    if (!row) throw new AppError('not_found', `No alert rule ${input.id}.`);
    const [open] = await ctx.tx
      .select()
      .from(schema.alertEvents)
      .where(and(eq(schema.alertEvents.ruleId, row.id), isNull(schema.alertEvents.resolvedAt)))
      .limit(1);
    return { rule: ruleOut(row, open) };
  },
});

export const deleteAlert = defineCommand({
  name: 'alerts.delete',
  title: 'Delete an alert rule',
  description: 'Delete a rule and its firing history. Pending alert notifications already queued are sent or retried normally.',
  input: z.object({ id: RuleId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const rows = await ctx.tx.delete(schema.alertRules).where(eq(schema.alertRules.id, input.id)).returning({ id: schema.alertRules.id });
    if (!rows.length) throw new AppError('not_found', `No alert rule ${input.id}.`);
    return { deleted: true as const };
  },
});

export const testAlert = defineCommand({
  name: 'alerts.test',
  title: 'Send a test alert',
  description:
    'Send one test notification to the rule’s webhook and e-mail channels with representative values, without opening a firing event. Use it after creating or changing a rule.',
  input: z.object({ id: RuleId }),
  output: z.object({ notifications: z.array(z.record(z.string(), z.unknown())) }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const rule = await loadRule(ctx.tx, input.id);
    const config = parseAlertConfig(rule.kind, rule.config);
    const threshold =
      rule.kind === 'deliverability'
        ? (config as DeliverabilityConfig).threshold
        : rule.kind === 'journey_errors'
          ? (config as JourneyErrorsConfig).threshold
          : (config as SignupDropConfig).minPrevious * (1 - (config as SignupDropConfig).dropPercent / 100);
    const value =
      rule.kind === 'journey_errors' ? threshold + 1 : rule.kind === 'signup_drop' ? Math.max(0, threshold - 1) : threshold * 1.25;
    const [workspace] = await ctx.tx
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    if (!workspace) throw new AppError('not_found', 'This workspace no longer exists.');
    const notifications = await notifyChannels(
      ctx.tx,
      notifyDeps(ctx),
      {
        workspace,
        rule: { id: rule.id, name: rule.name, kind: rule.kind, config },
        eventId: newId('alt'),
        event: 'test',
        value,
        threshold,
        window: (config as AlertConfig).window,
        ...(rule.kind === 'signup_drop' ? { previous: (config as SignupDropConfig).minPrevious } : {}),
        now: new Date(),
      },
      rule.channels,
    );
    return { notifications: notifications as unknown as Record<string, unknown>[] };
  },
});

export const alertHistory = defineCommand({
  name: 'alerts.history',
  title: 'Alert firing history',
  description:
    'Firing and resolved episodes, newest first, with the value, threshold, window and notification outcomes. Filter by rule with ruleId; limit defaults to 50.',
  input: z.object({
    ruleId: RuleId.optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  output: z.object({ events: z.array(Event) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const events = await ctx.tx
      .select()
      .from(schema.alertEvents)
      .where(input.ruleId ? eq(schema.alertEvents.ruleId, input.ruleId) : undefined)
      .orderBy(desc(schema.alertEvents.firedAt))
      .limit(input.limit);
    const ids = [...new Set(events.map((e) => e.ruleId))];
    const rules = ids.length
      ? await ctx.tx
          .select({ id: schema.alertRules.id, name: schema.alertRules.name })
          .from(schema.alertRules)
          .where(inArray(schema.alertRules.id, ids))
      : [];
    const names = new Map(rules.map((r) => [r.id, r.name]));
    return { events: events.map((e) => eventOut(e, names.get(e.ruleId) ?? e.ruleId)) };
  },
});

export const alertCommands = [listAlerts, getAlert, createAlert, updateAlert, deleteAlert, testAlert, alertHistory] as const;
