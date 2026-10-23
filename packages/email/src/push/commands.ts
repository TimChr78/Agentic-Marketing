import { contentValidators, DEFAULT_PURPOSES, type PushTemplate, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { profileForMessage } from '@agentic-marketing/profiles';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { MAX_PAYLOAD } from './crypto';
import { devicesOf, requestPush } from './gateway';
import { renderPush, validatePushTemplate } from './render';

contentValidators.set('push_template', (c) => validatePushTemplate(c as PushTemplate));

const Status = z.enum(['queued', 'sending', 'sent', 'suppressed', 'failed', 'delivered', 'bounced', 'complained']);
const ProfileId = z.string().regex(/^prf_[0-9a-f]{32}$/);

export const sendPush = defineCommand({
  name: 'messages.sendPush',
  title: 'Send a push notification to a person',
  description:
    'Ask the send gateway to notify one person, on every device they registered, with a published push template. Same checks as e-mail (lawful basis, consent, delivery policy); the answer says whether it was queued or why not. Repeat-safe with `idempotencyKey`.',
  input: z.object({
    profileId: ProfileId,
    templateId: z.string().regex(/^psh_[0-9a-f]{32}$/),
    idempotencyKey: z.string().min(1).max(200).optional(),
    data: z.record(z.string(), z.unknown()).optional().describe('Extra template variables'),
  }),
  output: z.object({ messageId: z.string(), status: Status, reason: z.string().nullable(), duplicate: z.boolean() }),
  permission: 'messages:send',
  effect: 'write',
  target: (i) => i.profileId,
  handler: async (input, ctx) => requestPush(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, ctx.services.events, input),
});

export const previewPush = defineCommand({
  name: 'pushTemplates.preview',
  title: 'Preview a push template',
  description:
    'Render a push template version (default: the latest) with its sample data or data you pass: the title, body and link as sent, and warnings about length (devices cut long text).',
  input: z.object({
    artifactId: z.string().regex(/^psh_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  output: z.object({
    version: z.number().int(),
    title: z.string(),
    body: z.string(),
    url: z.string().nullable(),
    warnings: z.array(z.string()),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [v] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.artifactId, input.artifactId),
          input.version ? eq(schema.artifactVersions.number, input.version) : undefined,
        ),
      )
      .orderBy(desc(schema.artifactVersions.number))
      .limit(1);
    if (!v) throw new AppError('not_found', `No push template ${input.artifactId}.`);
    const t = v.content as PushTemplate;
    let text: Awaited<ReturnType<typeof renderPush>>;
    try {
      text = await renderPush(t, { ...(t.sampleData ?? {}), ...(input.data ?? {}) });
    } catch (e) {
      throw new AppError('invalid_input', `The template could not be rendered with this data: ${(e as Error).message.split('\n')[0]}`);
    }
    const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
    const warnings: string[] = [];
    if (text.title.length > 50) warnings.push(`The title is ${text.title.length} characters; many devices show about 50`);
    if (text.body.length > 150) warnings.push(`The body is ${text.body.length} characters; many devices show about 150`);
    if (Buffer.byteLength(JSON.stringify(text)) > MAX_PAYLOAD / 2) warnings.push('Long notifications may be refused by push services');
    if (!purposes.find((p) => p.key === t.purpose)?.channels.includes('push'))
      warnings.push(`Purpose "${t.purpose}" is not marked for the push channel`);
    return { version: v.number, ...text, warnings };
  },
});

export const profileDevices = defineCommand({
  name: 'push.devices',
  title: 'Devices a person gets notifications on',
  description: 'The browsers and apps registered for push notifications by one person: kind and dates only, never the endpoint or token.',
  input: z.object({ profileId: ProfileId }),
  output: z.object({
    devices: z.array(
      z.object({ id: z.string(), kind: z.enum(['web', 'fcm', 'apns']), createdAt: z.string(), lastSentAt: z.string().nullable() }),
    ),
  }),
  permission: 'profiles:read',
  effect: 'read',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    const person = await profileForMessage(ctx.tx, ctx.principal.workspaceId, input.profileId, ctx.services.keyProvider);
    if (!person) throw new AppError('not_found', `No person ${input.profileId}.`);
    const rows = await devicesOf(ctx.tx, ctx.principal.workspaceId, person.id);
    return {
      devices: rows.map((d) => ({
        id: d.id,
        kind: d.kind,
        createdAt: d.createdAt.toISOString(),
        lastSentAt: d.lastSentAt?.toISOString() ?? null,
      })),
    };
  },
});

export const pushCommands = [sendPush, previewPush, profileDevices] as const;
