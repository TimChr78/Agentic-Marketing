import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requestEmail } from './gateway';
import { directSendLedger, sendTouches } from './sendTouches';

const Status = z.enum(['queued', 'sending', 'sent', 'suppressed', 'failed', 'delivered', 'bounced', 'complained']);

// A page is ordered by (created_at, id) newest first, so the cursor carries both. created_at is
// written with microseconds; keeping them in the cursor means a page boundary never skips or
// repeats a row that shares a millisecond with the last one.
const CURSOR = /^m1\.([A-Za-z0-9_-]+)$/;

function decodeCursor(cursor: string) {
  const m = CURSOR.exec(cursor);
  if (!m) throw new AppError('invalid_input', 'cursor is not one from an earlier messages.list call.');
  try {
    const v = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof v.at !== 'string' || typeof v.id !== 'string' || Number.isNaN(Date.parse(v.at))) throw new Error('bad cursor');
    return { at: v.at, id: v.id };
  } catch {
    throw new AppError('invalid_input', 'cursor is not one from an earlier messages.list call.');
  }
}

const encodeCursor = (at: string, id: string) => `m1.${Buffer.from(JSON.stringify({ at, id })).toString('base64url')}`;

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
  actionClass: 'send.direct',
  impact: async (input, ctx) => ({ people: 1, reversible: false, touches: await sendTouches(ctx.tx, input.templateId, 'email') }),
  target: (i) => i.profileId,
  // The ledger keeps the message it created, so mandate guardrails can find the agent's direct
  // sends in the metric layer (#265).
  ledgerImpact: directSendLedger,
  handler: async (input, ctx) => requestEmail(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, ctx.services.events, input),
});

export const listMessages = defineCommand({
  name: 'messages.list',
  title: 'Messages and what happened to them',
  description:
    'Recent messages, newest first, with their status and the reason when one was not sent ("why didn’t Ada get this?"), plus delivery events. Filter by person, channel, status, purpose or time, and page with `cursor` until `nextCursor` is null.',
  input: z.object({
    profileId: z
      .string()
      .regex(/^prf_[0-9a-f]{32}$/)
      .optional(),
    channel: z.string().min(1).max(32).optional().describe('e.g. email, sms or push'),
    status: Status.optional(),
    purpose: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional()
      .describe('The purpose the message was sent under, e.g. marketing_email'),
    since: isoDateTime('since').optional().describe('Only messages created at or after this time'),
    until: isoDateTime('until').optional().describe('Only messages created at or before this time'),
    cursor: z.string().max(500).optional().describe('`nextCursor` from an earlier call'),
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
    nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null when this is the last page'),
  }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const c = schema.messages;
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await ctx.tx
      .select({
        message: c,
        // Full precision for the cursor; the displayed createdAt stays an ISO string.
        at: sql<string>`to_char(${c.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(c)
      .where(
        and(
          input.profileId ? eq(c.profileId, input.profileId) : undefined,
          input.channel ? eq(c.channel, input.channel) : undefined,
          input.status ? eq(c.status, input.status) : undefined,
          input.purpose ? eq(c.purpose, input.purpose) : undefined,
          input.since ? gte(c.createdAt, new Date(input.since)) : undefined,
          input.until ? lte(c.createdAt, new Date(input.until)) : undefined,
          cursor ? sql`(${c.createdAt}, ${c.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
        ),
      )
      .orderBy(desc(c.createdAt), desc(c.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const events = page.length
      ? await ctx.services.events.messageEventsOf(ctx.principal.workspaceId, { messageIds: page.map((r) => r.message.id) }, 1000)
      : [];
    const last = page.at(-1);
    return {
      messages: page.map(({ message: r }) => ({
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
      nextCursor: hasMore && last ? encodeCursor(last.at, last.message.id) : null,
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
    variant: z.string().min(1).max(4).optional().describe('Only messages from this broadcast subject-test variant, e.g. "A"'),
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
    const since = new Date(Date.now() - input.days * 86_400_000);
    // A variant lives on the message, not the event, so narrow to its message ids first.
    const variantIds = input.variant
      ? (
          await ctx.tx
            .select({ id: schema.messages.id })
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.variant, input.variant),
                input.templateId ? eq(schema.messages.templateId, input.templateId) : undefined,
                input.journeyId ? eq(schema.messages.journeyId, input.journeyId) : undefined,
                gte(schema.messages.createdAt, since),
              ),
            )
        ).map((r) => r.id)
      : undefined;
    const counts =
      variantIds && variantIds.length === 0
        ? {}
        : await ctx.services.events.messageStats(ctx.principal.workspaceId, {
            since,
            templateId: input.templateId,
            journeyId: input.journeyId,
            messageIds: variantIds,
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
