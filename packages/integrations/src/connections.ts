import { randomBytes } from 'node:crypto';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId, sha256 } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { type KeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { connectors } from './connectors';
import { type EgressPolicy, safeRequest } from './egress';
import { accessTokenOf } from './oauth';
import type { Connector } from './sdk';

// Connections: a connector with this workspace's settings and sealed secrets. Inbound
// connections get a secret URL (shown once); actions run from journeys or connections.runAction.

declare module '@agentic-marketing/commands' {
  interface Services {
    egress?: EgressPolicy;
  }
}

export const inboundTokenHash = (token: string) => sha256(`inbound-hook:${token}`);
const ConnectionId = z.string().regex(/^con_[0-9a-f]{32}$/);
type Row = typeof schema.connections.$inferSelect;

export function connectorOf(id: string): Connector {
  const c = connectors[id];
  if (!c) throw new AppError('invalid_input', `Unknown connector "${id}". List them with connectors.list.`);
  return c;
}

export async function connectionSecrets(tx: Tx, row: Row, kp: KeyProvider): Promise<Record<string, unknown>> {
  return row.secrets && row.secretsKeyId ? openJson(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId) : {};
}

/** Runs a connector action with the connection's settings and secrets, through the egress guard. */
export async function runAction(row: Row, secrets: Record<string, unknown>, action: string, input: unknown, egress: EgressPolicy) {
  const c = connectorOf(row.connector);
  const a = c.actions?.[action];
  if (!a) throw new AppError('invalid_input', `${c.label} has no action "${action}".`);
  const parsed = a.input.safeParse(input ?? {});
  if (!parsed.success) throw new AppError('invalid_input', `Input for ${c.label} ${action} is not valid.`, z.treeifyError(parsed.error));
  return a.run(parsed.data, {
    settings: c.settings.parse(row.settings),
    secrets: c.secrets.parse(secrets),
    accessToken: c.auth === 'oauth2' && row.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined,
    request: (url, init) => safeRequest(url, init, egress),
  });
}

const schemaOf = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });

export const listConnectors = defineCommand({
  name: 'connectors.list',
  title: 'List connectors',
  description:
    'Connectors this install offers: what they receive (inbound webhooks) and the actions journeys can call, with settings, secrets and input schemas.',
  input: z.object({}),
  output: z.object({
    connectors: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string(),
        auth: z.string(),
        inbound: z.boolean(),
        settings: z.unknown(),
        secrets: z.unknown(),
        actions: z.array(z.object({ name: z.string(), label: z.string(), description: z.string(), input: z.unknown() })),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async () => ({
    connectors: Object.values(connectors).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      auth: c.auth,
      inbound: !!c.inbound,
      settings: schemaOf(c.settings),
      secrets: schemaOf(c.secrets),
      actions: Object.entries(c.actions ?? {}).map(([name, a]) => ({
        name,
        label: a.label,
        description: a.description,
        input: schemaOf(a.input),
      })),
    })),
  }),
});

const Connection = z.object({
  id: z.string(),
  connector: z.string(),
  name: z.string(),
  settings: z.record(z.string(), z.unknown()),
  hasSecrets: z.boolean(),
  inbound: z.boolean(),
  oauth: z
    .object({ status: z.enum(['pending', 'connected', 'error']), error: z.string().nullable(), expiresAt: z.string().nullable() })
    .nullable()
    .describe('OAuth 2.0 connections: whether they are connected (connections.authorize)'),
  enabled: z.boolean(),
  createdAt: z.string(),
});
const connectionOut = (r: Row) => ({
  id: r.id,
  connector: r.connector,
  name: r.name,
  settings: r.settings,
  hasSecrets: !!r.secrets,
  inbound: !!r.tokenHash,
  oauth: r.oauthStatus ? { status: r.oauthStatus, error: r.oauthError, expiresAt: r.tokenExpiresAt?.toISOString() ?? null } : null,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});

function checked(c: Connector, settings: unknown, secrets: unknown) {
  const s = c.settings.safeParse(settings ?? {});
  if (!s.success) throw new AppError('invalid_input', `Settings for ${c.label} are not valid.`, z.treeifyError(s.error));
  const k = secrets === undefined ? null : c.secrets.safeParse(secrets);
  if (k && !k.success) throw new AppError('invalid_input', `Secrets for ${c.label} are not valid.`, z.treeifyError(k.error));
  return { settings: s.data as Record<string, unknown>, secrets: k?.data as Record<string, unknown> | undefined };
}

async function sealed(tx: Tx, workspaceId: string, kp: KeyProvider, secrets: Record<string, unknown> | undefined) {
  if (!secrets || !Object.keys(secrets).length) return {};
  const s = await sealJson(tx, workspaceId, kp, secrets);
  return { secrets: s.blob, secretsKeyId: s.keyId };
}

export const listConnections = defineCommand({
  name: 'connections.list',
  title: 'List connections',
  description: 'Configured connections (a connector with settings). Secrets and inbound URLs are never shown again.',
  input: z.object({}),
  output: z.object({ connections: z.array(Connection) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_i, ctx) => ({
    connections: (await ctx.tx.select().from(schema.connections).orderBy(schema.connections.createdAt)).map(connectionOut),
  }),
});

export const createConnection = defineCommand({
  name: 'connections.create',
  title: 'Add a connection',
  description:
    'Connect a connector with settings and secrets. For connectors that receive webhooks, returns the inbound URL path once: register it (prefixed with your public URL) at the other system.',
  input: z.object({
    connector: z.string(),
    name: z.string().min(1).max(120),
    settings: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.unknown()).default({}),
  }),
  output: Connection.extend({ inboundPath: z.string().nullable() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  sensitiveOutput: ['inboundPath'],
  handler: async (input, ctx) => {
    const c = connectorOf(input.connector);
    const { settings, secrets } = checked(c, input.settings, input.secrets);
    const id = newId('con');
    const token = c.inbound ? randomBytes(24).toString('base64url') : null;
    const [row] = await ctx.tx
      .insert(schema.connections)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id,
        connector: c.id,
        name: input.name,
        settings,
        ...(await sealed(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, secrets)),
        tokenHash: token ? inboundTokenHash(token) : null,
      })
      .returning();
    return { ...connectionOut(row), inboundPath: token ? `/hooks/in/${id}/${token}` : null };
  },
});

export const updateConnection = defineCommand({
  name: 'connections.update',
  title: 'Change a connection',
  description: 'Change name, settings, secrets (replaced as a whole when given) or whether it is enabled.',
  input: z.object({
    id: ConnectionId,
    name: z.string().min(1).max(120).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  }),
  output: Connection,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  target: (i) => i.id,
  handler: async ({ id, settings, secrets, ...rest }, ctx) => {
    const [cur] = await ctx.tx.select().from(schema.connections).where(eq(schema.connections.id, id));
    if (!cur) throw new AppError('not_found', `No connection ${id}.`);
    const c = checked(connectorOf(cur.connector), settings ?? cur.settings, secrets);
    // New app credentials keep the tokens they already got (connect again to replace them).
    const tokens = c.secrets && cur.secrets ? (await connectionSecrets(ctx.tx, cur, ctx.services.keyProvider)).__oauth : undefined;
    if (c.secrets && tokens) c.secrets.__oauth = tokens;
    const [row] = await ctx.tx
      .update(schema.connections)
      .set({
        ...rest,
        settings: c.settings,
        ...(await sealed(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, c.secrets)),
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, id))
      .returning();
    return connectionOut(row);
  },
});

export const deleteConnection = defineCommand({
  name: 'connections.delete',
  title: 'Delete a connection',
  description: 'Remove a connection, its secrets and its inbound URL. Journey steps that use it take their error edge.',
  input: z.object({ id: ConnectionId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx.delete(schema.connections).where(eq(schema.connections.id, input.id)).returning({ id: schema.connections.id });
    if (!res.length) throw new AppError('not_found', `No connection ${input.id}.`);
    return { deleted: true as const };
  },
});

export const runConnectionAction = defineCommand({
  name: 'connections.runAction',
  title: 'Run a connector action',
  description: 'Call an action of a connection once, e.g. to try it before using it in a journey. It reaches the outside world.',
  input: z.object({ id: ConnectionId, action: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
  output: z.object({ result: z.unknown() }),
  permission: 'messages:send',
  effect: 'write',
  actionClass: 'data.write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.select().from(schema.connections).where(eq(schema.connections.id, input.id));
    if (!row?.enabled) throw new AppError('not_found', `No enabled connection ${input.id}.`);
    try {
      const secrets = await connectionSecrets(ctx.tx, row, ctx.services.keyProvider);
      return { result: await runAction(row, secrets, input.action, input.input, ctx.services.egress ?? { allowedHosts: [] }) };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('conflict', `The action failed: ${(err as Error).message}`);
    }
  },
});

export const connectionCommands = [
  listConnectors,
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  runConnectionAction,
] as const;
