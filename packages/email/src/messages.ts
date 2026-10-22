import { defineCommand } from '@agentic-marketing/commands';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requestEmail } from './gateway';

const Status = z.enum(['queued', 'sending', 'sent', 'suppressed', 'failed', 'delivered', 'bounced', 'complained']);

export const sendEmail = defineCommand({
  name: 'messages.sendEmail',
  title: 'Send an e-mail to a person',
  description:
    'Ask the send gateway to e-mail one person with a published template. The gateway checks the lawful basis of the template’s purpose, the person’s consent and objections, the suppression list and the address; the answer says whether it was queued or why not. Repeat-safe with `idempotencyKey`.',
  input: z.object({
    profileId: z.string().regex(/^prf_[0-9a-f]{32}$/),
    templateId: z.string().regex(/^eml_[0-9a-f]{32}$/),
    idempotencyKey: z.string().min(1).max(200).optional().describe('Same key, same message: a retry never sends twice'),
    data: z.record(z.string(), z.unknown()).optional().describe('Extra template variables, e.g. {"event":{"properties":{"sku":"TENT-2"}}}'),
  }),
  output: z.object({ messageId: z.string(), status: Status, reason: z.string().nullable(), duplicate: z.boolean() }),
  permission: 'messages:send',
  effect: 'write',
  target: (i) => i.profileId,
  handler: async (input, ctx) => requestEmail(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, ctx.services.events, input),
});

export const listMessages = defineCommand({
  name: 'messages.list',
  title: 'Messages and what happened to them',
  description:
    'Recent messages, optionally for one person, with their status and the reason when one was not sent ("why didn’t Ada get this?"), plus delivery events.',
  input: z.object({
    profileId: z
      .string()
      .regex(/^prf_[0-9a-f]{32}$/)
      .optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    messages: z.array(
      z.object({
        id: z.string(),
        profileId: z.string().nullable(),
        templateId: z.string().nullable(),
        templateVersion: z.number().nullable(),
        purpose: z.string(),
        status: Status,
        reason: z.string().nullable(),
        createdAt: z.string(),
        events: z.array(z.object({ type: z.string(), at: z.string(), reason: z.string(), url: z.string() })),
      }),
    ),
  }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.messages)
      .where(and(input.profileId ? eq(schema.messages.profileId, input.profileId) : undefined))
      .orderBy(desc(schema.messages.createdAt))
      .limit(input.limit);
    const events = rows.length
      ? await ctx.services.events.messageEventsOf(ctx.principal.workspaceId, { messageIds: rows.map((r) => r.id) }, 1000)
      : [];
    return {
      messages: rows.map((r) => ({
        id: r.id,
        profileId: r.profileId,
        templateId: r.templateId,
        templateVersion: r.templateVersion,
        purpose: r.purpose,
        status: r.status,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        events: events
          .filter((e) => e.messageId === r.id)
          .sort((a, b) => a.at.localeCompare(b.at))
          .map((e) => ({ type: e.type, at: e.at, reason: e.reason, url: e.url })),
      })),
    };
  },
});

export const messageCommands = [sendEmail, listMessages] as const;
