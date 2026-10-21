import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { commands } from '../commands';
import { CommandError, execute, httpStatus } from '../registry';
import { principalFromSession } from '../principal';

// REST surface: one RPC-style POST route per command, documented as OpenAPI 3.1.
// Generated from the registry; there is no hand-written route code per command.

const ErrorBody = z.object({ error: z.string(), message: z.string(), details: z.unknown().optional() });

export function restApi() {
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
      request: { body: { required: true, content: { 'application/json': { schema: cmd.input } } } },
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: cmd.output } } },
        400: { description: 'Invalid input', content: { 'application/json': { schema: ErrorBody } } },
        401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorBody } } },
        403: { description: 'Not allowed', content: { 'application/json': { schema: ErrorBody } } },
        404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
        409: { description: 'Conflict', content: { 'application/json': { schema: ErrorBody } } },
      },
    });

    // Document the route from the schemas, but let `execute` validate, so validation errors
    // are identical on every surface and are audited.
    api.openAPIRegistry.registerPath(route);
    api.post(route.path, async (c) => {
      const principal = await principalFromSession(c.req.raw.headers);
      if (!principal) return c.json({ error: 'unauthorized', message: 'Sign in first' }, 401);
      const body = await c.req.json().catch(() => ({}));
      try {
        const out = await execute(cmd, body, principal, { surface: 'rest', idempotencyKey: c.req.header('idempotency-key') });
        return c.json(out as object, 200);
      } catch (err) {
        if (err instanceof CommandError) return c.json({ error: err.code, message: err.message, details: err.details }, httpStatus[err.code] as 400);
        throw err;
      }
    });
  }

  api.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'Agentic Marketing API (spike)', version: '0.0.0' } });
  return api;
}
