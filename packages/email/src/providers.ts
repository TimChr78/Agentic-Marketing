import { randomBytes } from 'node:crypto';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId, sha256 } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { activeDataKey, dataKeyById, type KeyProvider, open, seal } from '@agentic-marketing/secrets';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type AdapterDeps, adapters, type EmailTransport } from './adapters';

// E-mail delivery providers (ADR-0011). Settings are readable; credentials are write-only and
// sealed with the workspace's secrets key. Each provider has a webhook URL with a secret token
// for its delivery events; the token is shown once.

const IV = 12;
const TAG = 16;
export const webhookTokenHash = (token: string) => sha256(`email-webhook:${token}`);

type ProviderRow = typeof schema.emailProviders.$inferSelect;

export async function sealSecrets(tx: Tx, workspaceId: string, kp: KeyProvider, secrets: Record<string, unknown>) {
  const dk = await activeDataKey(tx, workspaceId, kp);
  const s = seal(dk.key, Buffer.from(JSON.stringify(secrets), 'utf8'));
  return { secrets: Buffer.concat([s.iv, s.authTag, s.ciphertext]), secretsKeyId: dk.id };
}

export async function openSecrets(
  tx: Tx,
  row: Pick<ProviderRow, 'workspaceId' | 'secrets' | 'secretsKeyId'>,
  kp: KeyProvider,
): Promise<Record<string, unknown>> {
  if (!row.secrets || !row.secretsKeyId) return {};
  const key = await dataKeyById(tx, row.workspaceId, row.secretsKeyId, kp);
  const b = row.secrets;
  return JSON.parse(
    open(key, { iv: b.subarray(0, IV), authTag: b.subarray(IV, IV + TAG), ciphertext: b.subarray(IV + TAG) }).toString('utf8'),
  );
}

/** A ready transport for a provider row (credentials decrypted in this transaction). */
export async function transportFor(tx: Tx, row: ProviderRow, kp: KeyProvider, deps: AdapterDeps): Promise<EmailTransport> {
  const a = adapters[row.adapter];
  return a.create(a.config.parse(row.config), a.secrets.parse(await openSecrets(tx, row, kp)), deps);
}

const Use = z.enum(['transactional', 'marketing']);
const Tracking = z.enum(['forced', 'configurable', 'none']);
const Provider = z.object({
  id: z.string(),
  name: z.string(),
  adapter: z.enum(['smtp', 'ses', 'postmark', 'brevo', 'cloudflare', 'log']),
  config: z.record(z.string(), z.unknown()),
  fromEmail: z.string(),
  fromName: z.string(),
  replyTo: z.string().nullable(),
  useFor: z.array(Use),
  enabled: z.boolean(),
  hasCredentials: z.boolean(),
  tracking: Tracking.describe('Whether the provider tracks opens/clicks itself, and whether the platform can stop it'),
  trackingNote: z.string().describe('A short explanation of provider-side tracking'),
});
const providerOut = (r: ProviderRow) => {
  const a = adapters[r.adapter];
  return {
    id: r.id,
    name: r.name,
    adapter: r.adapter,
    config: r.config,
    fromEmail: r.fromEmail,
    fromName: r.fromName,
    replyTo: r.replyTo,
    useFor: r.useFor,
    enabled: r.enabled,
    hasCredentials: !!r.secrets,
    tracking: a.tracking,
    trackingNote: a.trackingNote,
  };
};

/**
 * Provider-side tracking can contradict the workspace's own promise. Warn when click tracking
 * is off here but an enabled marketing provider tracks every message anyway.
 */
function trackingWarnings(rows: ProviderRow[], trackClicks: boolean): string[] {
  if (trackClicks) return [];
  return rows
    .filter((r) => r.enabled && r.useFor.includes('marketing') && adapters[r.adapter].tracking === 'forced')
    .map(
      (r) =>
        `${adapters[r.adapter].label} provider "${r.name}" adds open and click tracking to every marketing e-mail although EMAIL_TRACK_CLICKS=false.`,
    );
}

function checkSettings(adapter: keyof typeof adapters, config: unknown, secrets: unknown) {
  const a = adapters[adapter];
  const c = a.config.safeParse(config ?? {});
  if (!c.success) throw new AppError('invalid_input', `Settings for ${a.label} are not valid.`, z.treeifyError(c.error));
  const s = secrets === undefined ? null : a.secrets.safeParse(secrets);
  if (s && !s.success) throw new AppError('invalid_input', `Credentials for ${a.label} are not valid.`, z.treeifyError(s.error));
  return { config: c.data as Record<string, unknown>, secrets: s?.data as Record<string, unknown> | undefined };
}

/** Each use (transactional, marketing) has one provider; giving it to one takes it from the others. */
async function claimUses(tx: Tx, id: string, uses: ('transactional' | 'marketing')[]) {
  if (!uses.length) return;
  const others = await tx.select().from(schema.emailProviders);
  for (const o of others)
    if (o.id !== id && o.useFor.some((u) => uses.includes(u)))
      await tx
        .update(schema.emailProviders)
        .set({ useFor: o.useFor.filter((u) => !uses.includes(u)) })
        .where(and(eq(schema.emailProviders.workspaceId, o.workspaceId), eq(schema.emailProviders.id, o.id)));
}

export const listProviders = defineCommand({
  name: 'emailProviders.list',
  title: 'List e-mail providers',
  description:
    'Configured delivery providers (SMTP, Amazon SES, Postmark, Brevo) and what they are used for. Credentials are never returned.',
  input: z.object({}),
  output: z.object({
    providers: z.array(Provider),
    adapters: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        config: z.unknown(),
        secrets: z.unknown(),
        tracking: Tracking,
        trackingNote: z.string(),
      }),
    ),
    warnings: z.array(z.string()).describe('Provider settings that contradict the workspace privacy settings'),
  }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_i, ctx) => {
    const rows = await ctx.tx.select().from(schema.emailProviders).orderBy(schema.emailProviders.createdAt);
    return {
      providers: rows.map(providerOut),
      adapters: Object.values(adapters).map((a) => ({
        id: a.id,
        label: a.label,
        config: z.toJSONSchema(a.config, { io: 'input' }),
        secrets: z.toJSONSchema(a.secrets, { io: 'input' }),
        tracking: a.tracking,
        trackingNote: a.trackingNote,
      })),
      warnings: trackingWarnings(rows, ctx.services.email.trackClicks),
    };
  },
});

const Email = z.email().max(320);

export const createProvider = defineCommand({
  name: 'emailProviders.create',
  title: 'Add an e-mail provider',
  description:
    'Add a delivery provider. `useFor` decides which messages go through it: transactional (contract/legal purposes) and/or marketing. Returns the full webhook URL for delivery events once; register it with the provider.',
  input: z.object({
    name: z.string().min(1).max(120),
    adapter: z.enum(['smtp', 'ses', 'postmark', 'brevo', 'cloudflare', 'log']),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.unknown()).default({}),
    fromEmail: Email,
    fromName: z.string().max(120).default(''),
    replyTo: Email.optional(),
    useFor: z.array(Use).max(2).default([]),
  }),
  output: Provider.extend({
    webhookPath: z.string().describe('POST delivery events here (prefix with your public links URL)'),
    webhookUrl: z.string().describe('Full URL for provider delivery events, built from PUBLIC_LINKS_URL'),
    warnings: z.array(z.string()).describe('Provider settings that contradict the workspace privacy settings'),
  }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  sensitiveOutput: ['webhookPath', 'webhookUrl'],
  handler: async (input, ctx) => {
    const { config, secrets } = checkSettings(input.adapter, input.config, input.secrets);
    const id = newId('epr');
    const token = randomBytes(24).toString('base64url');
    await claimUses(ctx.tx, id, input.useFor);
    const [row] = await ctx.tx
      .insert(schema.emailProviders)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id,
        name: input.name,
        adapter: input.adapter,
        config,
        ...(secrets && Object.keys(secrets).length
          ? await sealSecrets(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, secrets)
          : {}),
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        replyTo: input.replyTo ?? null,
        useFor: input.useFor,
        webhookTokenHash: webhookTokenHash(token),
      })
      .returning();
    const webhookPath = `/hooks/email/${id}/${token}`;
    return {
      ...providerOut(row),
      webhookPath,
      webhookUrl: `${ctx.services.email.publicUrl}${webhookPath}`,
      warnings: trackingWarnings([row], ctx.services.email.trackClicks),
    };
  },
});

export const updateProvider = defineCommand({
  name: 'emailProviders.update',
  title: 'Change an e-mail provider',
  description: 'Change settings, sender, uses or credentials (credentials are replaced as a whole when given).',
  input: z.object({
    id: z.string().regex(/^epr_[0-9a-f]{32}$/),
    name: z.string().min(1).max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.unknown()).optional(),
    fromEmail: Email.optional(),
    fromName: z.string().max(120).optional(),
    replyTo: Email.nullable().optional(),
    useFor: z.array(Use).max(2).optional(),
    enabled: z.boolean().optional(),
  }),
  output: Provider.extend({
    warnings: z.array(z.string()).describe('Provider settings that contradict the workspace privacy settings'),
  }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  target: (i) => i.id,
  handler: async ({ id, config, secrets, ...rest }, ctx) => {
    const [cur] = await ctx.tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.id, id));
    if (!cur) throw new AppError('not_found', `No e-mail provider ${id}. List them with emailProviders.list.`);
    const checked = checkSettings(cur.adapter, config ?? cur.config, secrets);
    if (rest.useFor) await claimUses(ctx.tx, id, rest.useFor);
    const [row] = await ctx.tx
      .update(schema.emailProviders)
      .set({
        ...rest,
        config: checked.config,
        ...(checked.secrets ? await sealSecrets(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, checked.secrets) : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.emailProviders.id, id))
      .returning();
    return { ...providerOut(row), warnings: trackingWarnings([row], ctx.services.email.trackClicks) };
  },
});

export const rotateProviderWebhook = defineCommand({
  name: 'emailProviders.rotateWebhook',
  title: 'Replace an e-mail provider webhook URL',
  description: 'Issue a new webhook URL for delivery events. The old URL stops working immediately; replace it with the provider.',
  input: z.object({ id: z.string().regex(/^epr_[0-9a-f]{32}$/) }),
  output: z.object({
    webhookPath: z.string().describe('POST delivery events here (prefix with your public links URL)'),
    webhookUrl: z.string().describe('Full URL for provider delivery events, built from PUBLIC_LINKS_URL'),
  }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['webhookPath', 'webhookUrl'],
  target: (i) => i.id,
  handler: async ({ id }, ctx) => {
    const token = randomBytes(24).toString('base64url');
    const [row] = await ctx.tx
      .update(schema.emailProviders)
      .set({ webhookTokenHash: webhookTokenHash(token), updatedAt: new Date() })
      .where(eq(schema.emailProviders.id, id))
      .returning({ id: schema.emailProviders.id });
    if (!row) throw new AppError('not_found', `No e-mail provider ${id}. List them with emailProviders.list.`);
    const webhookPath = `/hooks/email/${id}/${token}`;
    return { webhookPath, webhookUrl: `${ctx.services.email.publicUrl}${webhookPath}` };
  },
});

export const deleteProvider = defineCommand({
  name: 'emailProviders.delete',
  title: 'Delete an e-mail provider',
  description: 'Remove a provider and its credentials. Messages already sent keep their history.',
  input: z.object({ id: z.string().regex(/^epr_[0-9a-f]{32}$/) }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx
      .delete(schema.emailProviders)
      .where(eq(schema.emailProviders.id, input.id))
      .returning({ id: schema.emailProviders.id });
    if (!res.length) throw new AppError('not_found', `No e-mail provider ${input.id}.`);
    return { deleted: true as const };
  },
});

export const providerCommands = [listProviders, createProvider, updateProvider, rotateProviderWebhook, deleteProvider] as const;
