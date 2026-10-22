import { type Auth, principalFromSession } from '@agentic-marketing/auth';
import type { Executor } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { commands } from '../registry';

const ErrorBody = z.object({ error: z.string(), message: z.string(), details: z.unknown().optional() });
const errors = Object.fromEntries(
  [
    [400, 'The input does not match the schema'],
    [401, 'Not signed in'],
    [403, 'Not allowed for this role or agent'],
    [404, 'Not found'],
    [409, 'Conflicts with the current state'],
    [412, 'Changed since you read it'],
  ].map(([code, description]) => [code, { description, content: { 'application/json': { schema: ErrorBody } } }]),
);

type Json = Record<string, unknown>;

/**
 * A command schema as OpenAPI 3.1 JSON Schema, from Zod's own converter (it handles recursive
 * schemas such as segment conditions). Shared definitions move to components.schemas.
 */
function jsonSchema(api: OpenAPIHono, schema: unknown, name: string, io: 'input' | 'output'): Json {
  const {
    $defs,
    $schema: _,
    ...root
  } = z.toJSONSchema(schema as z.ZodType, { io, unrepresentable: 'any' }) as Json & { $defs?: Record<string, Json> };
  const rename = (k: string) => `${name}.${io}.${k}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const rewrite = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(rewrite)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [
              k,
              k === '$ref' && typeof x === 'string' && x.startsWith('#/$defs/') ? `#/components/schemas/${rename(x.slice(8))}` : rewrite(x),
            ]),
          )
        : v;
  for (const [k, def] of Object.entries($defs ?? {})) api.openAPIRegistry.registerComponent('schemas', rename(k), rewrite(def) as never);
  return rewrite(root) as Json;
}

/** One RPC-style POST route per command, documented as OpenAPI 3.1. Validation happens in the executor. */
export function restApi(deps: { auth: Auth; db: Db; executor: Executor }) {
  const api = new OpenAPIHono();
  for (const cmd of commands) {
    const route = createRoute({
      method: 'post',
      path: `/v1/${cmd.name}`,
      operationId: cmd.name,
      summary: cmd.title,
      description: cmd.description,
      tags: [cmd.name.split('.')[0]],
      'x-effect': cmd.effect,
      'x-permission': cmd.permission,
      'x-humans-only': cmd.humansOnly ?? false,
      request: {
        body: { required: true, content: { 'application/json': { schema: jsonSchema(api, cmd.input, cmd.name, 'input') as never } } },
      },
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: jsonSchema(api, cmd.output, cmd.name, 'output') as never } } },
        ...errors,
      },
    });
    api.openAPIRegistry.registerPath(route);
    api.post(route.path, async (c) => {
      const principal = await principalFromSession(deps.auth, deps.db, c.req.raw.headers);
      if (!principal) throw new AppError('unauthorized', 'Sign in first, or pick a workspace you are a member of with X-Workspace-Id.');
      const body = await c.req.json().catch(() => ({}));
      const out = await deps.executor.execute(cmd, body, principal, { surface: 'rest', idempotencyKey: c.req.header('idempotency-key') });
      return c.json(out as object, 200);
    });
  }
  api.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'Agentic Marketing API', version: '0.1.0' } });
  return api;
}
