import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type AgentEventType, schema } from '@agentic-marketing/db';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';

// Events for agents (#312; ADR-0016 §6). An agent subscribes to the event types its loop reacts to
// and pulls them from `agents.events`, or receives them at an outbound webhook (signed and retried
// by the delivery worker). A person may subscribe on an agent's behalf; an agent only itself.

export const AGENT_EVENT_TYPES = [
  'hold.ran',
  'hold.vetoed',
  'hold.needs_person',
  'approval.decided',
  'guardian.episode',
  'guardrail.breach',
  'experiment.significant',
  'alert.fired',
] as const satisfies readonly AgentEventType[];

const EventType = z.enum(AGENT_EVENT_TYPES);
const EventTypes = z.array(EventType).min(1).max(AGENT_EVENT_TYPES.length);
const Filter = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .describe('Subject ids to match, e.g. {"artifactId": "nt_…"}; every key must match the event’s subject');

const AGENT_ID = z.string().regex(/^agt_[0-9a-f]{32}$/, 'An agent id looks like agt_…');
const SUBSCRIPTION_ID = z.string().regex(/^sub_[0-9a-f]{32}$/, 'A subscription id looks like sub_…');
const WEBHOOK_ID = z.string().regex(/^whk_[0-9a-f]{32}$/, 'A webhook id looks like whk_…');

const Subscription = z.object({
  id: z.string(),
  agentId: z.string(),
  eventTypes: z.array(EventType),
  filter: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  webhookId: z.string().nullable().describe('Outbound webhook the events are delivered to; null: recorded for agents.events only'),
  createdAt: z.string(),
});

const subscriptionOut = (row: typeof schema.agentSubscriptions.$inferSelect) => ({
  id: row.id,
  agentId: row.agentId,
  eventTypes: row.eventTypes,
  filter: row.filter,
  webhookId: row.webhookId,
  createdAt: row.createdAt.toISOString(),
});

/** The agent a subscription command acts for: an agent itself, or the one a person names. */
async function targetAgent(ctx: CommandContext, requested: string | undefined, command: string): Promise<string> {
  if (ctx.principal.type === 'agent') {
    const own = ctx.principal.agent?.id;
    if (!own) throw new AppError('forbidden', 'This credential does not act as an agent.');
    if (requested && requested !== own)
      throw new AppError('forbidden', `${command} only manages an agent’s own subscriptions; ${requested} is another agent.`);
    return own;
  }
  if (!requested) throw new AppError('invalid_input', `Pass agentId: a person runs ${command} for one agent.`);
  const [agent] = await ctx.tx.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, requested));
  if (!agent) throw new AppError('not_found', `Agent ${requested} was not found.`);
  return requested;
}

export const subscribeAgent = defineCommand({
  name: 'agents.subscribe',
  title: 'Subscribe an agent to events',
  description:
    'Have an agent hear about what its loop reacts to instead of polling: a hold that ran or was vetoed or now needs a person, an approval decided, a guardian episode or guardrail breach, an experiment that reached a significant verdict, and an alert firing. With a webhookId the platform delivers each event to that signed webhook (retried like any delivery); without one the agent reads them with agents.events. Events carry ids and a summary, never personal data. An agent subscribes itself; a person can for any agent.',
  input: z.object({
    agentId: AGENT_ID.optional().describe('The agent that receives the events; omit as an agent to subscribe itself'),
    eventTypes: EventTypes.describe('Event types to receive'),
    filter: Filter.default({}),
    webhookId: WEBHOOK_ID.optional().describe('An outbound webhook endpoint to deliver to; omit to only record events for agents.events'),
  }),
  output: Subscription,
  permission: 'artifacts:read',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const agentId = await targetAgent(ctx, input.agentId, 'agents.subscribe');
    if (input.webhookId) {
      const [hook] = await ctx.tx
        .select({ id: schema.webhookEndpoints.id })
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, input.webhookId));
      if (!hook) throw new AppError('not_found', `No webhook endpoint ${input.webhookId}.`);
    }
    const [row] = await ctx.tx
      .insert(schema.agentSubscriptions)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('sub'),
        agentId,
        eventTypes: input.eventTypes,
        filter: input.filter,
        webhookId: input.webhookId ?? null,
      })
      .returning();
    return subscriptionOut(row);
  },
});

export const unsubscribeAgent = defineCommand({
  name: 'agents.unsubscribe',
  title: 'Unsubscribe an agent from events',
  description: 'Delete an event subscription. Events already recorded stay readable with agents.events; new ones are not delivered.',
  input: z.object({ id: SUBSCRIPTION_ID }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'artifacts:read',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .delete(schema.agentSubscriptions)
      .where(
        and(
          eq(schema.agentSubscriptions.id, input.id),
          ctx.principal.type === 'agent' ? eq(schema.agentSubscriptions.agentId, ctx.principal.agent?.id ?? '') : undefined,
        ),
      )
      .returning({ id: schema.agentSubscriptions.id });
    if (!rows.length) throw new AppError('not_found', `No subscription ${input.id} for this agent.`);
    return { deleted: true as const };
  },
});

export const listAgentSubscriptions = defineCommand({
  name: 'agents.subscriptions',
  title: 'Event subscriptions',
  description:
    'The event subscriptions of one agent, or every subscription in the workspace for a person. Types, subject filter, the webhook deliveries go to and when each was created.',
  input: z.object({
    agentId: AGENT_ID.optional().describe('The agent to list; omit as an agent to list itself, or as a person to list the workspace'),
  }),
  output: z.object({ subscriptions: z.array(Subscription) }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const agentId = ctx.principal.type === 'agent' ? await targetAgent(ctx, input.agentId, 'agents.subscriptions') : input.agentId;
    const rows = await ctx.tx
      .select()
      .from(schema.agentSubscriptions)
      .where(agentId ? eq(schema.agentSubscriptions.agentId, agentId) : undefined)
      .orderBy(desc(schema.agentSubscriptions.createdAt));
    return { subscriptions: rows.map(subscriptionOut) };
  },
});

const AgentEvent = z.object({
  id: z.number().int().describe('The cursor to pass as `after` next time'),
  agentId: z.string(),
  type: EventType,
  at: z.string(),
  summary: z.string(),
  subject: z.record(z.string(), z.unknown()).describe('Ids of what happened (approval, artifact, episode, rule…); never personal data'),
});

export const agentEvents = defineCommand({
  name: 'agents.events',
  title: 'Agent events',
  description:
    'Recent events for an agent, oldest first, since a cursor (`after`). This is the polling fallback when the client cannot receive webhook deliveries: subscribe with agents.subscribe, then pass the last event id back as `after`. Each event carries ids, its type, its time and a short summary, never personal data.',
  input: z.object({
    agentId: AGENT_ID.optional().describe('The agent whose events to read; omit as an agent for its own'),
    after: z.number().int().min(0).default(0).describe('The last event id already read (the cursor)'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    events: z.array(AgentEvent),
    cursor: z.number().int().describe('The last event id in this page, or `after` when there was nothing new'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const agentId = await targetAgent(ctx, input.agentId, 'agents.events');
    const rows = await ctx.tx
      .select()
      .from(schema.agentEvents)
      .where(and(eq(schema.agentEvents.agentId, agentId), gt(schema.agentEvents.id, input.after)))
      .orderBy(asc(schema.agentEvents.id))
      .limit(input.limit);
    return {
      events: rows.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        type: row.type,
        at: row.at.toISOString(),
        summary: row.summary,
        subject: row.subject,
      })),
      cursor: rows.at(-1)?.id ?? input.after,
    };
  },
});

export const agentEventCommands = [subscribeAgent, unsubscribeAgent, listAgentSubscriptions, agentEvents] as const;
