import { AiUnavailable, modelFor, releaseTokens, reserveTokens } from '@agentic-marketing/ai';
import { type Auth, principalFromSession } from '@agentic-marketing/auth';
import { agentPrincipal, type Executor, type Permission, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { dynamicTool, isStepCount, jsonSchema, type ModelMessage, streamText } from 'ai';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { mcpServerFor } from './mcp';

// The in-app copilot (agents-and-mcp.md §6) is just another MCP client: it acts as an agent
// principal for the signed-in person, sees the tools of the same MCP server an external agent
// gets, and every call goes through the executor (validation, permissions, approvals, audit).
// Sending, approving, erasing, personal data and settings are not granted to it.

const MAX_STEPS = 12;
const COPILOT_SCOPES: Permission[] = [
  'artifacts:read',
  'artifacts:write',
  'artifacts:publish',
  'audit:read',
  'profiles:read',
  'profiles:write',
  'secrets:read',
];

const SYSTEM = `You are the copilot of an agent-first marketing platform. You work through tools that are the platform's commands, as an agent acting for the signed-in person.
- Changes you make are drafts. Publishing follows the workspace's approval policy; a person approves agent changes. You cannot send messages, approve, erase people or change settings.
- Before building something, look at what exists (artifacts.list, artifacts.types, segments.preview, journeys.simulate). Validate and simulate before you request publishing.
- Tool errors explain what to fix; fix the input and try again.
- Answer briefly and concretely. Mention the ids of what you created or changed.`;

const Body = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z
    .string()
    .regex(/^cop_[0-9a-f]{32}$/)
    .optional()
    .describe('Continue this conversation; without it a new one starts'),
});

/**
 * What the copilot streams, one JSON object per line: the conversation, tokens of text as they
 * are written (delta), tool calls and their results, then done. Stored turns keep the text whole.
 */
export type CopilotEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'user'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; id: string; name: string; ok: boolean; output: unknown }
  | { type: 'error'; message: string }
  | { type: 'done'; conversationId: string; usage: { inputTokens: number; outputTokens: number } };

/** How many earlier turns the model sees (the stored conversation keeps them all). */
const HISTORY_TURNS = 20;

/** MCP tool names may contain dots; model APIs allow letters, digits, _ and - only. */
const toolName = (name: string) => name.replaceAll('.', '__');
const COPILOT_TURN_TOKENS = 20_000;

export function copilotApi(deps: { auth: Auth; db: Db; executor: Executor; kp: KeyProvider }) {
  const app = new Hono();
  app.post('/api/copilot', async (c) => {
    const user = await principalFromSession(deps.auth, deps.db, c.req.raw.headers);
    if (!user) throw new AppError('unauthorized', 'Sign in first.');
    const parsed = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError('invalid_input', 'Send {"message": "…", "conversationId"?: "cop_…"}.', z.treeifyError(parsed.error));
    const { message } = parsed.data;
    const ws = user.workspaceId;
    // The conversation is the person's own; its earlier turns are the model's history.
    const conversation = await deps.db.withWorkspace(ws, async (tx) => {
      if (!parsed.data.conversationId) return { id: newId('cop'), title: message.slice(0, 80), turns: 0, history: [] as ModelMessage[] };
      const [c] = await tx
        .select()
        .from(schema.copilotConversations)
        .where(and(eq(schema.copilotConversations.id, parsed.data.conversationId), eq(schema.copilotConversations.userId, user.userId)));
      if (!c) throw new AppError('not_found', `No conversation ${parsed.data.conversationId}.`);
      const turns = await tx
        .select({ n: schema.copilotTurns.n, messages: schema.copilotTurns.messages })
        .from(schema.copilotTurns)
        .where(eq(schema.copilotTurns.conversationId, c.id))
        .orderBy(desc(schema.copilotTurns.n))
        .limit(HISTORY_TURNS);
      return {
        id: c.id,
        title: c.title,
        turns: turns[0]?.n ?? 0,
        history: turns.reverse().flatMap((t) => t.messages as ModelMessage[]),
      };
    });
    const model = await deps.db
      .withWorkspace(ws, (tx) => modelFor(tx, deps.kp, 'copilot'))
      .catch((err) => {
        if (err instanceof AiUnavailable)
          throw new AppError('conflict', `The copilot cannot answer: ${err.message}. An admin can set one up under AI providers.`);
        throw err;
      });
    const principal = agentPrincipal(
      user.userId,
      'copilot',
      ws,
      user.role,
      COPILOT_SCOPES.filter((p) => ROLE_PERMISSIONS[user.role].includes(p)),
    );

    // A turn may take several model steps; hold enough of the budget for one before starting.
    const reservation = await reserveTokens(deps.db, ws, model.providerId, COPILOT_TURN_TOKENS).catch((err) => {
      if (err instanceof AiUnavailable) throw new AppError('conflict', `The copilot cannot answer: ${err.message}.`);
      throw err;
    });

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // What the person sees is also what is stored, with streamed text joined into whole texts.
        const shown: CopilotEvent[] = [{ type: 'user', text: message }];
        let pending = '';
        const flush = () => {
          if (pending) shown.push({ type: 'text', text: pending });
          pending = '';
        };
        const emit = (e: CopilotEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
          if (e.type === 'delta') pending += e.text;
          else if (e.type === 'tool' || e.type === 'toolResult' || e.type === 'error') {
            flush();
            shown.push(e);
          }
        };
        let messages: ModelMessage[] = [];
        const server = mcpServerFor(principal, deps.executor);
        const client = new Client({ name: 'copilot', version: '0.2.0' });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const started = Date.now();
        let usage = { inputTokens: 0, outputTokens: 0 };
        let error: string | null = null;
        const used: string[] = [];
        emit({ type: 'conversation', id: conversation.id, title: conversation.title });
        try {
          await server.connect(serverSide);
          await client.connect(clientSide);
          const { tools } = await client.listTools();
          const toolset = Object.fromEntries(
            tools.map((t) => [
              toolName(t.name),
              dynamicTool({
                description: t.description ?? t.title ?? t.name,
                inputSchema: jsonSchema(t.inputSchema as never),
                execute: async (input, { toolCallId }) => {
                  used.push(t.name);
                  emit({ type: 'tool', id: toolCallId, name: t.name, input });
                  const r = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> });
                  const text = (r.content as { type: string; text?: string }[] | undefined)?.find((x) => x.type === 'text')?.text;
                  const output = r.structuredContent ?? (text ? JSON.parse(text) : null);
                  emit({ type: 'toolResult', id: toolCallId, name: t.name, ok: !r.isError, output });
                  return output;
                },
              }),
            ]),
          );
          const r = streamText({
            model: model.model,
            system: SYSTEM,
            messages: [...conversation.history, { role: 'user', content: message }],
            tools: toolset,
            stopWhen: isStepCount(MAX_STEPS),
            maxOutputTokens: 2000,
            maxRetries: 1,
            timeout: 120_000,
          });
          // Tokens go to the browser as the model writes them.
          for await (const part of r.stream) {
            if (part.type === 'text-delta' && part.text) emit({ type: 'delta', text: part.text });
            else if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
          const total = await r.totalUsage;
          usage = { inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0 };
          if ((await r.finishReason) === 'tool-calls')
            emit({
              type: 'delta',
              text: `I stopped after ${MAX_STEPS} steps without finishing. Tell me how to continue, or narrow the task.`,
            });
          flush();
          messages = [{ role: 'user', content: message }, ...((await r.responseMessages) as ModelMessage[])];
          emit({ type: 'done', conversationId: conversation.id, usage });
        } catch (err) {
          error = (err as Error).message;
          logger.warn({ err }, 'copilot turn failed');
          emit({ type: 'error', message: `The model call failed: ${error}` });
        } finally {
          flush();
          await client.close().catch(() => {});
          // The turn is kept even when it failed, so the person sees what happened next time too.
          await deps.db
            .withWorkspace(ws, async (tx) => {
              await tx
                .insert(schema.copilotConversations)
                .values({ workspaceId: ws, id: conversation.id, userId: user.userId, title: conversation.title })
                .onConflictDoUpdate({
                  target: [schema.copilotConversations.workspaceId, schema.copilotConversations.id],
                  set: { updatedAt: new Date() },
                });
              await tx.insert(schema.copilotTurns).values({
                workspaceId: ws,
                conversationId: conversation.id,
                n: conversation.turns + 1,
                messages: messages.length ? messages : [{ role: 'user', content: message }],
                events: shown,
                ...usage,
              });
            })
            .catch((err) => logger.error({ err }, 'copilot turn not stored'));
          await deps.db
            .withWorkspace(ws, (tx) =>
              tx.insert(schema.aiCalls).values({
                workspaceId: ws,
                id: newId('aic'),
                kind: 'copilot',
                status: error ? 'failed' : 'done',
                providerId: model.providerId,
                model: model.modelId,
                input: { tools: used },
                error,
                ...usage,
                latencyMs: Date.now() - started,
                principalId: user.userId,
                finishedAt: new Date(),
              }),
            )
            .catch((err) => logger.error({ err }, 'copilot call not logged'));
          await releaseTokens(deps.db, ws, reservation).catch(() => {});
          controller.close();
        }
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  });
  return app;
}
