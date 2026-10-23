import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AdapterDeps } from '../adapters/types';
import { openSecrets, sealSecrets } from '../providers';
import { type PushTransport, pushAdapters } from './adapters';
import { vapidKeys } from './crypto';

// Push providers (Phase 11): like SMS providers, readable settings and write-only sealed
// credentials, one provider per use and kind of device. A web push provider needs no account: its
// VAPID key pair is generated here, and the public half is what browsers subscribe with.

type Row = typeof schema.pushProviders.$inferSelect;
type AdapterId = keyof typeof pushAdapters;

export async function pushTransportFor(tx: Tx, row: Row, kp: KeyProvider, deps: AdapterDeps): Promise<PushTransport> {
  const a = pushAdapters[row.adapter];
  return a.create(a.config.parse(row.config) as never, a.secrets.parse(await openSecrets(tx, row, kp)) as never, deps);
}

const Use = z.enum(['transactional', 'marketing']);
const AdapterEnum = z.enum(['webpush', 'fcm', 'apns', 'log']);
const Provider = z.object({
  id: z.string(),
  name: z.string(),
  adapter: AdapterEnum,
  config: z.record(z.string(), z.unknown()),
  useFor: z.array(Use),
  enabled: z.boolean(),
  hasCredentials: z.boolean(),
});
const out = (r: Row) => ({
  id: r.id,
  name: r.name,
  adapter: r.adapter,
  config: r.config,
  useFor: r.useFor,
  enabled: r.enabled,
  hasCredentials: !!r.secrets,
});

function checkSettings(adapter: AdapterId, config: unknown, secrets: unknown) {
  const a = pushAdapters[adapter] as { label: string; config: z.ZodType; secrets: z.ZodType };
  const c = a.config.safeParse(config ?? {});
  if (!c.success) throw new AppError('invalid_input', `Settings for ${a.label} are not valid.`, z.treeifyError(c.error));
  const s = secrets === undefined ? null : a.secrets.safeParse(secrets);
  if (s && !s.success) throw new AppError('invalid_input', `Credentials for ${a.label} are not valid.`, z.treeifyError(s.error));
  return { config: c.data as Record<string, unknown>, secrets: s?.data as Record<string, unknown> | undefined };
}

/** A use belongs to one provider per kind of device: giving it to one takes it from the others of that kind. */
async function claimUses(tx: Tx, id: string, adapter: AdapterId, uses: ('transactional' | 'marketing')[]) {
  if (!uses.length) return;
  const kinds = pushAdapters[adapter].kinds as string[];
  for (const o of await tx.select().from(schema.pushProviders))
    if (o.id !== id && (pushAdapters[o.adapter].kinds as string[]).some((k) => kinds.includes(k)) && o.useFor.some((u) => uses.includes(u)))
      await tx
        .update(schema.pushProviders)
        .set({ useFor: o.useFor.filter((u) => !uses.includes(u)) })
        .where(and(eq(schema.pushProviders.workspaceId, o.workspaceId), eq(schema.pushProviders.id, o.id)));
}

const ProviderId = z.string().regex(/^pup_[0-9a-f]{32}$/);

export const listPushProviders = defineCommand({
  name: 'pushProviders.list',
  title: 'List push providers',
  description: 'Configured push providers (web push, FCM, APNs) with their uses. Credentials are never returned; the VAPID public key is.',
  input: z.object({}),
  output: z.object({ providers: z.array(Provider) }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_i, ctx) => ({
    providers: (await ctx.tx.select().from(schema.pushProviders).orderBy(schema.pushProviders.createdAt)).map(out),
  }),
});

export const createPushProvider = defineCommand({
  name: 'pushProviders.create',
  title: 'Add a push provider',
  description:
    'Add a push provider. webpush (browsers): give `config.subject` (mailto: or https: contact); the VAPID keys are generated. fcm (Android): `config.projectId` and the service account (`secrets.clientEmail`, `secrets.privateKey`). apns (Apple): `config.teamId`, `keyId`, `topic` and the .p8 key as `secrets.privateKey`. `useFor`: transactional and/or marketing.',
  input: z.object({
    name: z.string().min(1).max(120),
    adapter: AdapterEnum,
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.unknown()).optional(),
    useFor: z.array(Use).max(2).default([]),
  }),
  output: Provider,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  handler: async (input, ctx) => {
    let { config: rawConfig, secrets: rawSecrets } = input;
    if (input.adapter === 'webpush' && rawSecrets === undefined && rawConfig.publicKey === undefined) {
      const keys = vapidKeys();
      rawConfig = { ...rawConfig, publicKey: keys.publicKey };
      rawSecrets = { privateKey: keys.privateKey };
    }
    const { config, secrets } = checkSettings(input.adapter, rawConfig, rawSecrets ?? {});
    const id = newId('pup');
    const ws = ctx.principal.workspaceId;
    await claimUses(ctx.tx, id, input.adapter, input.useFor);
    const [row] = await ctx.tx
      .insert(schema.pushProviders)
      .values({
        workspaceId: ws,
        id,
        name: input.name,
        adapter: input.adapter,
        config,
        ...(secrets && Object.keys(secrets).length ? await sealSecrets(ctx.tx, ws, ctx.services.keyProvider, secrets) : {}),
        useFor: input.useFor,
      })
      .returning();
    return out(row);
  },
});

export const updatePushProvider = defineCommand({
  name: 'pushProviders.update',
  title: 'Change a push provider',
  description:
    'Change settings, uses or credentials (replaced as a whole when given). Changing a web push key pair unsubscribes every browser, so it is refused; add a new provider instead.',
  input: z.object({
    id: ProviderId,
    name: z.string().min(1).max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.unknown()).optional(),
    useFor: z.array(Use).max(2).optional(),
    enabled: z.boolean().optional(),
  }),
  output: Provider,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  target: (i) => i.id,
  handler: async ({ id, config, secrets, ...rest }, ctx) => {
    const [cur] = await ctx.tx.select().from(schema.pushProviders).where(eq(schema.pushProviders.id, id));
    if (!cur) throw new AppError('not_found', `No push provider ${id}. List them with pushProviders.list.`);
    if (
      cur.adapter === 'webpush' &&
      (secrets !== undefined || (config?.publicKey !== undefined && config.publicKey !== cur.config.publicKey))
    )
      throw new AppError('invalid_input', 'The VAPID keys of a web push provider cannot change: browsers subscribed with them.');
    const checked = checkSettings(cur.adapter, { ...cur.config, ...(config ?? {}) }, secrets);
    if (rest.useFor) await claimUses(ctx.tx, id, cur.adapter, rest.useFor);
    const [row] = await ctx.tx
      .update(schema.pushProviders)
      .set({
        ...rest,
        config: checked.config,
        ...(checked.secrets ? await sealSecrets(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, checked.secrets) : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.pushProviders.id, id))
      .returning();
    return out(row);
  },
});

export const deletePushProvider = defineCommand({
  name: 'pushProviders.delete',
  title: 'Delete a push provider',
  description: 'Remove a provider and its credentials. Notifications already sent keep their history.',
  input: z.object({ id: ProviderId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx
      .delete(schema.pushProviders)
      .where(eq(schema.pushProviders.id, input.id))
      .returning({ id: schema.pushProviders.id });
    if (!res.length) throw new AppError('not_found', `No push provider ${input.id}.`);
    return { deleted: true as const };
  },
});

export const pushProviderCommands = [listPushProviders, createPushProvider, updatePushProvider, deletePushProvider] as const;
