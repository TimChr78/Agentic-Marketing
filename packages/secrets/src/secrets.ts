import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type KeyProvider, newDataKey, open, seal } from './keys';

declare module '@agentic-marketing/commands' {
  interface Services {
    keyProvider: KeyProvider;
  }
}

/** The workspace's active data key, created (and wrapped by the KEK) on first use. */
async function activeDataKey(tx: Tx, workspaceId: string, kp: KeyProvider) {
  const [k] = await tx
    .select()
    .from(schema.dataKeys)
    .where(and(eq(schema.dataKeys.workspaceId, workspaceId), eq(schema.dataKeys.active, true)));
  if (k) return { id: k.id, key: await kp.unwrap(k.wrappedKey) };
  const key = newDataKey();
  const id = newId('dk');
  await tx.insert(schema.dataKeys).values({ workspaceId, id, kekId: kp.id, wrappedKey: await kp.wrap(key) });
  return { id, key };
}

/** Server-side read of a secret (e.g. an LLM API key). Not exposed as a command: secrets are write-only. */
export async function readSecret(tx: Tx, workspaceId: string, name: string, kp: KeyProvider): Promise<string | null> {
  const [s] = await tx
    .select()
    .from(schema.secrets)
    .where(and(eq(schema.secrets.workspaceId, workspaceId), eq(schema.secrets.name, name)));
  if (!s) return null;
  const [k] = await tx
    .select()
    .from(schema.dataKeys)
    .where(and(eq(schema.dataKeys.workspaceId, workspaceId), eq(schema.dataKeys.id, s.dataKeyId)));
  return open(await kp.unwrap(k.wrappedKey), s).toString('utf8');
}

const SecretName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
  .describe('Lowercase name, e.g. "llm.anthropic.api_key"');

export const setSecret = defineCommand({
  name: 'secrets.set',
  title: 'Store a secret',
  description: 'Store or replace a secret such as a provider API key. Secrets are encrypted and can never be read back through the API.',
  input: z.object({ name: SecretName, value: z.string().min(1).max(16_384) }),
  output: z.object({ name: z.string(), updatedAt: z.string() }),
  permission: 'secrets:write',
  effect: 'write',
  humansOnly: true,
  sensitive: ['value'],
  target: (i) => i.name,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const dk = await activeDataKey(ctx.tx, ws, ctx.services.keyProvider);
    const sealed = seal(dk.key, Buffer.from(input.value, 'utf8'));
    const row = { workspaceId: ws, name: input.name, dataKeyId: dk.id, ...sealed, updatedBy: ctx.principal.userId, updatedAt: new Date() };
    await ctx.tx
      .insert(schema.secrets)
      .values(row)
      .onConflictDoUpdate({ target: [schema.secrets.workspaceId, schema.secrets.name], set: row });
    return { name: input.name, updatedAt: row.updatedAt.toISOString() };
  },
});

export const listSecrets = defineCommand({
  name: 'secrets.list',
  title: 'List secrets',
  description: 'Names of stored secrets with who changed them and when. Values are never returned.',
  input: z.object({}),
  output: z.object({ secrets: z.array(z.object({ name: z.string(), updatedBy: z.string(), updatedAt: z.string() })) }),
  permission: 'secrets:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const rows = await ctx.tx
      .select({ name: schema.secrets.name, updatedBy: schema.secrets.updatedBy, updatedAt: schema.secrets.updatedAt })
      .from(schema.secrets)
      .orderBy(schema.secrets.name);
    return { secrets: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
  },
});

export const deleteSecret = defineCommand({
  name: 'secrets.delete',
  title: 'Delete a secret',
  description: 'Permanently delete a stored secret.',
  input: z.object({ name: SecretName }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'secrets:write',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.name,
  handler: async (input, ctx) => {
    const res = await ctx.tx
      .delete(schema.secrets)
      .where(and(eq(schema.secrets.workspaceId, ctx.principal.workspaceId), eq(schema.secrets.name, input.name)))
      .returning({ name: schema.secrets.name });
    if (!res.length) throw new AppError('not_found', `No secret named ${input.name}.`);
    return { deleted: true };
  },
});

export const secretCommands = [setSecret, listSecrets, deleteSecret] as const;
