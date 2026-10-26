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
        channel: z.string(),
        profileId: z.string().nullable(),
        templateId: z.string().nullable(),
        templateVersion: z.number().nullable(),
        purpose: z.string(),
        status: Status,
        reason: z.string().nullable(),
        attempts: z.number().int().describe('How many times delivery was tried'),
        nextAttemptAt: z.string().nullable().describe('When a queued retry becomes claimable'),
        lastError: z.string().nullable().describe('The last failure or refusal; never provider credentials'),
        notBefore: z.string().nullable().describe('Held back until then (quiet hours, a paused stream)'),
        segments: z.number().nullable().describe('SMS segments used'),
        test: z.boolean().describe('A test send, not counted in reporting'),
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
        channel: r.channel,
        profileId: r.profileId,
        templateId: r.templateId,
        templateVersion: r.templateVersion,
        purpose: r.purpose,
        status: r.status,
        reason: r.reason,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
        // `reason` is the message's last failure/refusal; provider errors carry only the
        // provider's own message (never the API key or SMTP password).
        lastError: r.reason,
        notBefore: r.notBefore?.toISOString() ?? null,
        segments: r.segments,
        test: r.test,
        createdAt: r.createdAt.toISOString(),
        events: events
          .filter((e) => e.messageId === r.id)
          .sort((a, b) => a.at.localeCompare(b.at))
          .map((e) => ({ type: e.type, at: e.at, reason: e.reason, url: e.url })),
      })),
    };
  },
});

export const messageStats = defineCommand({
  name: 'messages.stats',
  title: 'E-mail performance',
  description:
    'Messages and what became of them over the last `days`, for the workspace, one template or one journey: decided, sent, delivered, bounced, complained, clicked, unsubscribed, with rates relative to sent. Opens are not tracked (no pixels).',
  input: z.object({
    days: z.number().int().min(1).max(400).default(30),
    templateId: z
      .string()
      .regex(/^eml_[0-9a-f]{32}$/)
      .optional(),
    journeyId: z
      .string()
      .regex(/^jrn_[0-9a-f]{32}$/)
      .optional(),
  }),
  output: z.object({
    counts: z.record(z.string(), z.number()),
    rates: z.object({
      delivered: z.number().nullable(),
      bounced: z.number().nullable(),
      complained: z.number().nullable(),
      clicked: z.number().nullable(),
      unsubscribed: z.number().nullable(),
    }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const counts = await ctx.services.events.messageStats(ctx.principal.workspaceId, {
      since: new Date(Date.now() - input.days * 86_400_000),
      templateId: input.templateId,
      journeyId: input.journeyId,
    });
    const sent = counts.sent ?? 0;
    const rate = (k: string) => (sent ? Math.round(((counts[k] ?? 0) / sent) * 10_000) / 100 : null);
    return {
      counts,
      rates: {
        delivered: rate('delivered'),
        bounced: rate('bounced'),
        complained: rate('complained'),
        clicked: rate('clicked'),
        unsubscribed: rate('unsubscribed'),
      },
    };
  },
});

export const messageCommands = [sendEmail, listMessages, messageStats] as const;
