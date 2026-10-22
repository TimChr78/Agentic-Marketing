import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

// Copilot conversations, kept on the server per person: each turn stores the model messages
// (so the conversation continues with full context) and the events the person saw (so it can be
// shown again on any device). Only the person who had the conversation can read or delete it.

const ConversationId = z.string().regex(/^cop_[0-9a-f]{32}$/);

export const listConversations = defineCommand({
  name: 'copilot.conversations',
  title: 'My copilot conversations',
  description: 'Your copilot conversations in this workspace, most recent first.',
  input: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
  output: z.object({
    conversations: z.array(z.object({ id: z.string(), title: z.string(), turns: z.number().int(), updatedAt: z.string() })),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  humansOnly: true,
  handler: async (input, ctx) => {
    const c = schema.copilotConversations;
    const rows = await ctx.tx
      .select({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        turns: sql<number>`(SELECT count(*)::int FROM copilot_turns t WHERE t.conversation_id = ${c.id})`,
      })
      .from(c)
      .where(eq(c.userId, ctx.principal.userId))
      .orderBy(desc(c.updatedAt))
      .limit(input.limit);
    return { conversations: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
  },
});

export const getConversation = defineCommand({
  name: 'copilot.conversation',
  title: 'A copilot conversation',
  description: 'What was said in one of your copilot conversations: your messages, the answers and the tools the copilot used.',
  input: z.object({ id: ConversationId }),
  output: z.object({ id: z.string(), title: z.string(), events: z.array(z.record(z.string(), z.unknown())) }),
  permission: 'artifacts:read',
  effect: 'read',
  humansOnly: true,
  handler: async (input, ctx) => {
    const [c] = await ctx.tx
      .select()
      .from(schema.copilotConversations)
      .where(and(eq(schema.copilotConversations.id, input.id), eq(schema.copilotConversations.userId, ctx.principal.userId)));
    if (!c) throw new AppError('not_found', `No conversation ${input.id}.`);
    const turns = await ctx.tx
      .select({ events: schema.copilotTurns.events })
      .from(schema.copilotTurns)
      .where(eq(schema.copilotTurns.conversationId, c.id))
      .orderBy(asc(schema.copilotTurns.n));
    return { id: c.id, title: c.title, events: turns.flatMap((t) => t.events as Record<string, unknown>[]) };
  },
});

export const deleteConversation = defineCommand({
  name: 'copilot.deleteConversation',
  title: 'Delete a copilot conversation',
  description: 'Delete one of your copilot conversations and everything said in it.',
  input: z.object({ id: ConversationId }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'artifacts:read',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const done = await ctx.tx
      .delete(schema.copilotConversations)
      .where(and(eq(schema.copilotConversations.id, input.id), eq(schema.copilotConversations.userId, ctx.principal.userId)))
      .returning({ id: schema.copilotConversations.id });
    if (!done.length) throw new AppError('not_found', `No conversation ${input.id}.`);
    return { deleted: true };
  },
});

export const copilotCommands = [listConversations, getConversation, deleteConversation] as const;
