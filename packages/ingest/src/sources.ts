import { randomBytes } from 'node:crypto';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId, sha256 } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

// Event sources and their write keys. Browser keys are public (they sit in the page) and only
// work from allowed origins; server keys are secrets shown once.

export const keyHash = (key: string) => sha256(`write-key:${key}`);
const newKey = (kind: 'browser' | 'server') =>
  `${kind === 'browser' ? 'pk' : 'sk'}_${randomBytes(kind === 'browser' ? 18 : 32).toString('base64url')}`;

const Origin = z
  .string()
  .regex(/^(\*|https?:\/\/[a-z0-9.-]+(:\d+)?)$/i, 'An origin like https://shop.example.com, or * for any')
  .transform((o) => o.toLowerCase());

const Source = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['browser', 'server']),
  writeKey: z.string().nullable().describe('Public write key of a browser source; null for server sources'),
  keyHint: z.string(),
  allowedOrigins: z.array(z.string()),
  requiredPurpose: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
const sourceOut = (r: typeof schema.sources.$inferSelect) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  writeKey: r.publicKey,
  keyHint: r.keyHint,
  allowedOrigins: r.allowedOrigins,
  requiredPurpose: r.requiredPurpose,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});
const SourceId = z.string().regex(/^src_[0-9a-f]{32}$/);

export const listSources = defineCommand({
  name: 'sources.list',
  title: 'List event sources',
  description: 'Websites and servers that send events, with their settings. Server keys are never shown again.',
  input: z.object({}),
  output: z.object({ sources: z.array(Source) }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_i, ctx) => ({
    sources: (await ctx.tx.select().from(schema.sources).orderBy(schema.sources.createdAt)).map(sourceOut),
  }),
});

export const createSource = defineCommand({
  name: 'sources.create',
  title: 'Add an event source',
  description:
    'Add a website (browser: public write key, only from allowed origins, events need the visitor’s consent for `requiredPurpose`) or a server (secret key, shown only in this response). Send events with the Segment HTTP API to /v1/batch.',
  input: z.object({
    name: z.string().min(1).max(120),
    kind: z.enum(['browser', 'server']),
    allowedOrigins: z.array(Origin).max(50).default([]),
    requiredPurpose: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable()
      .optional()
      .describe('Purpose the visitor must allow before events are kept. Browser default "analytics"; server default none'),
  }),
  output: Source.extend({ key: z.string().describe('The write key. For server sources, store it now; it is not shown again.') }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['key'],
  handler: async (input, ctx) => {
    if (input.kind === 'browser' && !input.allowedOrigins.length)
      throw new AppError(
        'invalid_input',
        'A browser source needs at least one allowed origin, e.g. https://shop.example.com (or * for any).',
      );
    const key = newKey(input.kind);
    const [row] = await ctx.tx
      .insert(schema.sources)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('src'),
        name: input.name,
        kind: input.kind,
        keyHash: keyHash(key),
        publicKey: input.kind === 'browser' ? key : null,
        keyHint: `${key.slice(0, 7)}…`,
        allowedOrigins: input.allowedOrigins,
        requiredPurpose: input.requiredPurpose === undefined ? (input.kind === 'browser' ? 'analytics' : null) : input.requiredPurpose,
      })
      .returning();
    return { ...sourceOut(row), key };
  },
});

export const updateSource = defineCommand({
  name: 'sources.update',
  title: 'Change an event source',
  description: 'Rename, enable/disable, or change allowed origins or the required purpose of a source.',
  input: z.object({
    id: SourceId,
    name: z.string().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    allowedOrigins: z.array(Origin).max(50).optional(),
    requiredPurpose: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable()
      .optional(),
  }),
  output: Source,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.id,
  handler: async ({ id, ...changes }, ctx) => {
    const [row] = await ctx.tx
      .update(schema.sources)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(schema.sources.id, id))
      .returning();
    if (!row) throw new AppError('not_found', `No source ${id}. List them with sources.list.`);
    if (row.kind === 'browser' && !row.allowedOrigins.length)
      throw new AppError('invalid_input', 'A browser source needs at least one allowed origin.');
    return sourceOut(row);
  },
});

export const rotateSourceKey = defineCommand({
  name: 'sources.rotateKey',
  title: 'Replace a source’s write key',
  description: 'Issue a new write key; the old one stops working within a minute. Update your site or server with the new key.',
  input: z.object({ id: SourceId }),
  output: Source.extend({ key: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['key'],
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [current] = await ctx.tx.select().from(schema.sources).where(eq(schema.sources.id, input.id));
    if (!current) throw new AppError('not_found', `No source ${input.id}.`);
    const key = newKey(current.kind);
    const [row] = await ctx.tx
      .update(schema.sources)
      .set({
        keyHash: keyHash(key),
        publicKey: current.kind === 'browser' ? key : null,
        keyHint: `${key.slice(0, 7)}…`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.sources.id, input.id)))
      .returning();
    return { ...sourceOut(row), key };
  },
});

export const deleteSource = defineCommand({
  name: 'sources.delete',
  title: 'Delete an event source',
  description: 'Delete a source; its key stops working within a minute. Events already collected are kept.',
  input: z.object({ id: SourceId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx.delete(schema.sources).where(eq(schema.sources.id, input.id)).returning({ id: schema.sources.id });
    if (!res.length) throw new AppError('not_found', `No source ${input.id}.`);
    return { deleted: true as const };
  },
});

export const sourceCommands = [listSources, createSource, updateSource, rotateSourceKey, deleteSource] as const;
