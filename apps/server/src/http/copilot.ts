import { AiUnavailable, modelFor } from '@agentic-marketing/ai';
import { type Auth, principalFromSession } from '@agentic-marketing/auth';
import { agentPrincipal, type Executor, type Permission, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { dynamicTool, generateText, isStepCount, jsonSchema, type ModelMessage } from 'ai';
import { Hono } from 'hono';
import { z } from 'zod';
import { mcpServerFor } from './mcp';

// The in-app copilot (agents-and-mcp.md §6) is just another MCP client: it acts as an agent
// principal for the signed-in person, sees the tools of the same MCP server an external agent
// gets, and every call goes through the executor (validation, permissions, approvals, audit).
// Sending, approving, erasing, personal data and settings are not granted to it.

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
  history: z.array(z.unknown()).max(200).default([]).describe('The messages of the conversation so far, as returned in "done"'),
});

export type CopilotEvent =
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; id: string; name: string; ok: boolean; output: unknown }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; history: ModelMessage[]; usage: { inputTokens: number; outputTokens: number } };

/** MCP tool names may contain dots; model APIs allow letters, digits, _ and - only. */
const toolName = (name: string) => name.replaceAll('.', '__');

export function copilotApi(deps: { auth: Auth; db: Db; executor: Executor; kp: KeyProvider }) {
  const app = new Hono();
  app.post('/api/copilot', async (c) => {
    const user = await principalFromSession(deps.auth, deps.db, c.req.raw.headers);
    if (!user) throw new AppError('unauthorized', 'Sign in first.');
    const parsed = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError('invalid_input', 'Send {"message": "…", "history": [...]}.', z.treeifyError(parsed.error));
    const { message, history } = parsed.data;
    const ws = user.workspaceId;
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

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (e: CopilotEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        const server = mcpServerFor(principal, deps.executor);
        const client = new Client({ name: 'copilot', version: '0.1.0' });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const started = Date.now();
        let usage = { inputTokens: 0, outputTokens: 0 };
        let error: string | null = null;
        const used: string[] = [];
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
          const r = await generateText({
            model: model.model,
            system: SYSTEM,
            messages: [...(history as ModelMessage[]), { role: 'user', content: message }],
            tools: toolset,
            stopWhen: isStepCount(12),
            maxOutputTokens: 2000,
            maxRetries: 1,
            timeout: 120_000,
            onStepFinish: (step) => {
              if (step.text && step.toolCalls.length) emit({ type: 'text', text: step.text });
            },
          });
          usage = { inputTokens: r.totalUsage.inputTokens ?? 0, outputTokens: r.totalUsage.outputTokens ?? 0 };
          if (r.text) emit({ type: 'text', text: r.text });
          emit({
            type: 'done',
            history: [...(history as ModelMessage[]), { role: 'user', content: message }, ...r.response.messages],
            usage,
          });
        } catch (err) {
          error = (err as Error).message;
          logger.warn({ err }, 'copilot turn failed');
          emit({ type: 'error', message: `The model call failed: ${error}` });
        } finally {
          await client.close().catch(() => {});
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
          controller.close();
        }
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  });
  return app;
}
