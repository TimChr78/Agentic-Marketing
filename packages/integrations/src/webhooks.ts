import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { consentStateOf, purposeAllowed, type ResolvedEvent } from '@agentic-marketing/profiles';
import { type KeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { checkUrl } from './egress';
import { newWebhookSecret } from './signing';

// Outbound webhooks: endpoints subscribe to customer events (after identity resolution, so each
// carries the profile id) and journeys send to them from webhook steps. Deliveries are signed
// (Standard Webhooks), retried with backoff and end in a dead letter that can be retried by hand.

const EndpointId = z.string().regex(/^whk_[0-9a-f]{32}$/);
type EndpointRow = typeof schema.webhookEndpoints.$inferSelect;

const Endpoint = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  purpose: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
const endpointOut = (r: EndpointRow) => ({
  id: r.id,
  name: r.name,
  url: r.url,
  events: r.events,
  purpose: r.purpose,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});

export async function endpointSecret(tx: Tx, row: EndpointRow, kp: KeyProvider): Promise<string> {
  return (await openJson<{ secret: string }>(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId)).secret;
}

const Events = z
  .array(z.string().min(1).max(200))
  .max(100)
  .describe(
    'Event names to send, e.g. ["Order Completed", "Segment Entered"]; "identify" for identify calls; "*" for every event. Empty: only journey webhook steps.',
  );

export const listWebhooks = defineCommand({
  name: 'webhooks.list',
  title: 'List webhook endpoints',
  description: 'Endpoints that receive events and journey webhook steps. Signing secrets are never shown again.',
  input: z.object({}),
  output: z.object({ endpoints: z.array(Endpoint) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_i, ctx) => ({
    endpoints: (await ctx.tx.select().from(schema.webhookEndpoints).orderBy(schema.webhookEndpoints.createdAt)).map(endpointOut),
  }),
});

export const createWebhook = defineCommand({
  name: 'webhooks.create',
  title: 'Add a webhook endpoint',
  description:
    'An HTTPS endpoint (n8n, Zapier, your own service) that receives signed JSON (Standard Webhooks headers). With a purpose, only events of people for whom it is allowed are sent. Returns the signing secret once.',
  input: z.object({
    name: z.string().min(1).max(120),
    url: z.url().max(2000),
    events: Events.default([]),
    purpose: z.string().max(64).optional().describe('Purpose key the receiver processes data for, e.g. "analytics"'),
  }),
  output: Endpoint.extend({ secret: z.string().describe('Verify webhook-signature with it (whsec_…)') }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['secret'],
  handler: async (input, ctx) => {
    const problem = checkUrl(input.url, ctx.services.egress ?? { allowedHosts: [] });
    if (problem) throw new AppError('invalid_input', `The URL cannot be used: ${problem}.`);
    const secret = newWebhookSecret();
    const sealed = await sealJson(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, { secret });
    const [row] = await ctx.tx
      .insert(schema.webhookEndpoints)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('whk'),
        name: input.name,
        url: input.url,
        events: input.events,
        purpose: input.purpose ?? null,
        secrets: sealed.blob,
        secretsKeyId: sealed.keyId,
      })
      .returning();
    return { ...endpointOut(row), secret };
  },
});

export const updateWebhook = defineCommand({
  name: 'webhooks.update',
  title: 'Change a webhook endpoint',
  description: 'Change URL, events, purpose or whether it is enabled. `rotateSecret` returns a new signing secret once.',
  input: z.object({
    id: EndpointId,
    name: z.string().min(1).max(120).optional(),
    url: z.url().max(2000).optional(),
    events: Events.optional(),
    purpose: z.string().max(64).nullable().optional(),
    enabled: z.boolean().optional(),
    rotateSecret: z.boolean().default(false),
  }),
  output: Endpoint.extend({ secret: z.string().nullable() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['secret'],
  target: (i) => i.id,
  handler: async ({ id, rotateSecret, ...rest }, ctx) => {
    if (rest.url) {
      const problem = checkUrl(rest.url, ctx.services.egress ?? { allowedHosts: [] });
      if (problem) throw new AppError('invalid_input', `The URL cannot be used: ${problem}.`);
    }
    const secret = rotateSecret ? newWebhookSecret() : null;
    const sealed = secret ? await sealJson(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, { secret }) : null;
    const [row] = await ctx.tx
      .update(schema.webhookEndpoints)
      .set({ ...rest, ...(sealed ? { secrets: sealed.blob, secretsKeyId: sealed.keyId } : {}), updatedAt: new Date() })
      .where(eq(schema.webhookEndpoints.id, id))
      .returning();
    if (!row) throw new AppError('not_found', `No webhook endpoint ${id}.`);
    return { ...endpointOut(row), secret };
  },
});

export const deleteWebhook = defineCommand({
  name: 'webhooks.delete',
  title: 'Delete a webhook endpoint',
  description: 'Stop sending to an endpoint. Pending deliveries to it are dropped.',
  input: z.object({ id: EndpointId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx
      .delete(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, input.id))
      .returning({ id: schema.webhookEndpoints.id });
    if (!res.length) throw new AppError('not_found', `No webhook endpoint ${input.id}.`);
    await ctx.tx
      .delete(schema.deliveries)
      .where(and(eq(schema.deliveries.targetId, input.id), inArray(schema.deliveries.status, ['pending', 'running'])));
    return { deleted: true as const };
  },
});

export const testWebhook = defineCommand({
  name: 'webhooks.test',
  title: 'Send a test webhook',
  description: 'Queue a "ping" delivery to an endpoint; see the outcome with deliveries.list.',
  input: z.object({ id: EndpointId }),
  output: z.object({ deliveryId: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [e] = await ctx.tx.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, input.id));
    if (!e) throw new AppError('not_found', `No webhook endpoint ${input.id}.`);
    const id = newId('dlv');
    await ctx.tx.insert(schema.deliveries).values({
      workspaceId: ctx.principal.workspaceId,
      id,
      kind: 'webhook',
      targetId: e.id,
      payload: { type: 'ping', timestamp: new Date().toISOString(), data: { message: 'Hello from Agentic Marketing' } },
      status: 'pending',
      idempotencyKey: `test:${id}`,
    });
    return { deliveryId: id };
  },
});

const Delivery = z.object({
  id: z.string(),
  kind: z.enum(['webhook', 'action', 'ad_conversion']),
  targetId: z.string(),
  action: z.string().nullable(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'dead']),
  attempts: z.number(),
  nextAttemptAt: z.string(),
  statusCode: z.number().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().nullable(),
  payload: z.unknown(),
  response: z.unknown(),
  createdAt: z.string(),
});

export const listDeliveries = defineCommand({
  name: 'deliveries.list',
  title: 'Webhook and action deliveries',
  description:
    'Recent deliveries to webhook endpoints and connector actions, newest first, with attempts, status codes and errors. `dead` ones gave up.',
  input: z.object({
    targetId: z.string().optional().describe('An endpoint (whk_…) or connection (con_…) id'),
    status: z.enum(['pending', 'running', 'done', 'failed', 'dead']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ deliveries: z.array(Delivery) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const d = schema.deliveries;
    const rows = await ctx.tx
      .select()
      .from(d)
      .where(and(input.targetId ? eq(d.targetId, input.targetId) : undefined, input.status ? eq(d.status, input.status) : undefined))
      .orderBy(desc(d.createdAt))
      .limit(input.limit);
    return {
      deliveries: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        targetId: r.targetId,
        action: r.action,
        status: r.status,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt.toISOString(),
        statusCode: r.statusCode,
        error: r.error,
        durationMs: r.durationMs,
        payload: r.payload,
        response: r.response,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

export const retryDelivery = defineCommand({
  name: 'deliveries.retry',
  title: 'Retry a delivery',
  description: 'Send a dead or failed webhook delivery again now.',
  input: z.object({ id: z.string().regex(/^dlv_[0-9a-f]{32}$/) }),
  output: z.object({ queued: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx
      .update(schema.deliveries)
      .set({ status: 'pending', nextAttemptAt: new Date(), attempts: 0 })
      .where(
        and(
          eq(schema.deliveries.id, input.id),
          eq(schema.deliveries.kind, 'webhook'),
          inArray(schema.deliveries.status, ['dead', 'failed']),
        ),
      )
      .returning({ id: schema.deliveries.id });
    if (!res.length) throw new AppError('not_found', `No dead or failed webhook delivery ${input.id}.`);
    return { queued: true as const };
  },
});

export const webhookCommands = [
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  listDeliveries,
  retryDelivery,
] as const;

const matches = (events: string[], e: ResolvedEvent['event']) =>
  events.includes('*') || (e.type === 'track' ? events.includes(e.name) : events.includes(e.type));

/** The after-resolve hook: queues a delivery per subscribed endpoint and event, if the endpoint's purpose allows it. */
export function webhookHook(db: Db) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    if (!resolved.length) return;
    await db.withWorkspace(workspaceId, async (tx) => {
      const endpoints = (await tx.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.enabled, true))).filter(
        (e) => e.events.length,
      );
      if (!endpoints.length) return;
      const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
      const consent = new Map<string, Awaited<ReturnType<typeof consentStateOf>>>();
      const traits = new Map<string, Record<string, unknown>>();
      for (const { event: e, profileId } of resolved)
        for (const ep of endpoints) {
          if (!matches(ep.events, e)) continue;
          if (ep.purpose) {
            if (!consent.has(profileId)) consent.set(profileId, await consentStateOf(tx, workspaceId, profileId));
            const basis = purposes.find((p) => p.key === ep.purpose)?.basis ?? 'consent';
            const state = consent.get(profileId)!.find((s) => s.purpose === ep.purpose && s.channel === '');
            if (!purposeAllowed(basis, state?.status)) continue;
          }
          if (!traits.has(profileId)) {
            const [p] = await tx.select({ traits: schema.profiles.traits }).from(schema.profiles).where(eq(schema.profiles.id, profileId));
            traits.set(profileId, p?.traits ?? {});
          }
          await tx
            .insert(schema.deliveries)
            .values({
              workspaceId,
              id: newId('dlv'),
              kind: 'webhook',
              targetId: ep.id,
              payload: {
                type: `event.${e.type}`,
                timestamp: e.timestamp,
                data: {
                  event: { messageId: e.messageId, type: e.type, name: e.name, properties: e.properties, timestamp: e.timestamp },
                  profile: { id: profileId, traits: traits.get(profileId) },
                },
              },
              status: 'pending',
              idempotencyKey: `wh:${ep.id}:${e.messageId}`,
              profileId,
            })
            .onConflictDoNothing();
        }
    });
  };
}
