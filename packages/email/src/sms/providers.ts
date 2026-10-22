import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId, sha256 } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AdapterDeps } from '../adapters';
import type { LinkSigner } from '../links';
import { openSecrets, sealSecrets } from '../providers';
import { type SmsTransport, smsAdapters } from './adapters';

// SMS providers (Phase 7). Like e-mail providers: readable settings, write-only sealed credentials,
// one provider per use. The webhook URL (status callbacks and inbound texts) carries a signed
// token, so the gateway can give the provider a status callback URL with every message.

type Row = typeof schema.smsProviders.$inferSelect;

const Billing = z.object({
  pricePerSegment: z.number().min(0).max(10).default(0).describe('What one segment costs you, for estimates and the budget'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  monthlyBudget: z.number().min(0).optional().describe('Texts stop for the rest of the month when this would be exceeded'),
  helpText: z.string().max(300).default('Reply STOP to unsubscribe.').describe('Answer to an inbound HELP'),
});
export type SmsBilling = z.output<typeof Billing>;
export const billingOf = (row: Row): SmsBilling => Billing.parse((row.config as { billing?: unknown }).billing ?? {});

export const smsWebhookToken = (links: LinkSigner, workspaceId: string, id: string) => links.sign({ w: workspaceId, sms: id });
export const smsWebhookPath = (links: LinkSigner, workspaceId: string, id: string) =>
  `/hooks/sms/${smsWebhookToken(links, workspaceId, id)}`;

export async function smsTransportFor(tx: Tx, row: Row, kp: KeyProvider, deps: AdapterDeps): Promise<SmsTransport> {
  const a = smsAdapters[row.adapter];
  return a.create(a.config.parse(row.config), a.secrets.parse(await openSecrets(tx, row, kp)), deps);
}

const Use = z.enum(['transactional', 'marketing']);
const Provider = z.object({
  id: z.string(),
  name: z.string(),
  adapter: z.enum(['twilio', 'log']),
  config: z.record(z.string(), z.unknown()),
  billing: Billing,
  sender: z.string(),
  useFor: z.array(Use),
  enabled: z.boolean(),
  hasCredentials: z.boolean(),
});
const out = (r: Row) => {
  const { billing: _b, ...config } = r.config as Record<string, unknown>;
  return {
    id: r.id,
    name: r.name,
    adapter: r.adapter,
    config,
    billing: billingOf(r),
    sender: r.sender,
    useFor: r.useFor,
    enabled: r.enabled,
    hasCredentials: !!r.secrets,
  };
};

function checkSettings(adapter: keyof typeof smsAdapters, config: unknown, secrets: unknown) {
  const a = smsAdapters[adapter];
  const c = a.config.safeParse(config ?? {});
  if (!c.success) throw new AppError('invalid_input', `Settings for ${a.label} are not valid.`, z.treeifyError(c.error));
  const s = secrets === undefined ? null : a.secrets.safeParse(secrets);
  if (s && !s.success) throw new AppError('invalid_input', `Credentials for ${a.label} are not valid.`, z.treeifyError(s.error));
  return { config: c.data as Record<string, unknown>, secrets: s?.data as Record<string, unknown> | undefined };
}

async function claimUses(tx: Tx, id: string, uses: ('transactional' | 'marketing')[]) {
  if (!uses.length) return;
  for (const o of await tx.select().from(schema.smsProviders))
    if (o.id !== id && o.useFor.some((u) => uses.includes(u)))
      await tx
        .update(schema.smsProviders)
        .set({ useFor: o.useFor.filter((u) => !uses.includes(u)) })
        .where(and(eq(schema.smsProviders.workspaceId, o.workspaceId), eq(schema.smsProviders.id, o.id)));
}

const Sender = z
  .string()
  .regex(
    /^(\+[1-9]\d{6,14}|[A-Za-z][A-Za-z0-9 ]{1,10})$/,
    'A phone number in E.164 (+4512345678) or an alphanumeric sender id (up to 11 characters)',
  );

export const listSmsProviders = defineCommand({
  name: 'smsProviders.list',
  title: 'List SMS providers',
  description: 'Configured SMS providers (Twilio) with sender, uses, price and budget. Credentials are never returned.',
  input: z.object({}),
  output: z.object({ providers: z.array(Provider.extend({ webhookPath: z.string() })) }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_i, ctx) => ({
    providers: (await ctx.tx.select().from(schema.smsProviders).orderBy(schema.smsProviders.createdAt)).map((r) => ({
      ...out(r),
      webhookPath: smsWebhookPath(ctx.services.email.links, r.workspaceId, r.id),
    })),
  }),
});

export const createSmsProvider = defineCommand({
  name: 'smsProviders.create',
  title: 'Add an SMS provider',
  description:
    "Add an SMS provider. `useFor`: transactional (service texts) and/or marketing. Returns the webhook path: set <links URL><webhookPath>/inbound as the number's incoming-message webhook, so STOP and HELP work.",
  input: z.object({
    name: z.string().min(1).max(120),
    adapter: z.enum(['twilio', 'log']),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.unknown()).default({}),
    sender: Sender,
    useFor: z.array(Use).max(2).default([]),
    billing: Billing.prefault({}),
  }),
  output: Provider.extend({ webhookPath: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  handler: async (input, ctx) => {
    const { config, secrets } = checkSettings(input.adapter, input.config, input.secrets);
    const id = newId('smp');
    const ws = ctx.principal.workspaceId;
    await claimUses(ctx.tx, id, input.useFor);
    const [row] = await ctx.tx
      .insert(schema.smsProviders)
      .values({
        workspaceId: ws,
        id,
        name: input.name,
        adapter: input.adapter,
        config: { ...config, billing: input.billing },
        ...(secrets && Object.keys(secrets).length ? await sealSecrets(ctx.tx, ws, ctx.services.keyProvider, secrets) : {}),
        sender: input.sender,
        useFor: input.useFor,
        webhookTokenHash: sha256(`sms-webhook:${id}`),
      })
      .returning();
    return { ...out(row), webhookPath: smsWebhookPath(ctx.services.email.links, ws, id) };
  },
});

export const updateSmsProvider = defineCommand({
  name: 'smsProviders.update',
  title: 'Change an SMS provider',
  description: 'Change settings, sender, uses, price and budget, or credentials (replaced as a whole when given).',
  input: z.object({
    id: z.string().regex(/^smp_[0-9a-f]{32}$/),
    name: z.string().min(1).max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.unknown()).optional(),
    sender: Sender.optional(),
    useFor: z.array(Use).max(2).optional(),
    billing: Billing.optional(),
    enabled: z.boolean().optional(),
  }),
  output: Provider,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  target: (i) => i.id,
  handler: async ({ id, config, secrets, billing, ...rest }, ctx) => {
    const [cur] = await ctx.tx.select().from(schema.smsProviders).where(eq(schema.smsProviders.id, id));
    if (!cur) throw new AppError('not_found', `No SMS provider ${id}. List them with smsProviders.list.`);
    const checked = checkSettings(cur.adapter, config ?? cur.config, secrets);
    if (rest.useFor) await claimUses(ctx.tx, id, rest.useFor);
    const [row] = await ctx.tx
      .update(schema.smsProviders)
      .set({
        ...rest,
        config: { ...checked.config, billing: billing ?? billingOf(cur) },
        ...(checked.secrets ? await sealSecrets(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, checked.secrets) : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.smsProviders.id, id))
      .returning();
    return out(row);
  },
});

export const deleteSmsProvider = defineCommand({
  name: 'smsProviders.delete',
  title: 'Delete an SMS provider',
  description: 'Remove a provider and its credentials. Texts already sent keep their history.',
  input: z.object({ id: z.string().regex(/^smp_[0-9a-f]{32}$/) }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx
      .delete(schema.smsProviders)
      .where(eq(schema.smsProviders.id, input.id))
      .returning({ id: schema.smsProviders.id });
    if (!res.length) throw new AppError('not_found', `No SMS provider ${input.id}.`);
    return { deleted: true as const };
  },
});

export const smsProviderCommands = [listSmsProviders, createSmsProvider, updateSmsProvider, deleteSmsProvider] as const;
