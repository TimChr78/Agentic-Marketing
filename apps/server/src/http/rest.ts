import { type Auth, assertWorkspaceHeader, principalFromApiToken, principalFromSession } from '@agentic-marketing/auth';
import { type Executor, IDEMPOTENCY_KEY_MAX, type Principal } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { bodyLimit } from '@agentic-marketing/ingest';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { commands } from '../registry';
import { VERSION } from '../version';
import { type BrowserRequestPolicy, csrfRefusal } from './csrf';

const ErrorBody = z.object({ error: z.string(), message: z.string(), details: z.unknown().optional() });

// Every command except assets.upload carries a document or a settings object; 1 MB bounds an
// unauthenticated request before parsing without getting in the way of real payloads.
const REST_MAX_BODY = 1024 * 1024;
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
export function restApi(deps: { auth: Auth; db: Db; executor: Executor; assetMaxBytes: number; origin: BrowserRequestPolicy }) {
  const api = new OpenAPIHono();
  const assetLimitMb = (deps.assetMaxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
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
        headers: z.object({
          'idempotency-key': z.string().min(1).max(IDEMPOTENCY_KEY_MAX).optional().openapi({
            description:
              'Optional. A retry of the same logical request must reuse its key: the first response is replayed and the command runs once. A key reused for a different command or input answers 409 (details.reason "idempotency_key_reused"). A 409 whose details.reason is "idempotency_in_progress" means the first request is still running after ten seconds: retry with this same key shortly; a new key would run it again.',
          }),
        }),
        body: { required: true, content: { 'application/json': { schema: jsonSchema(api, cmd.input, cmd.name, 'input') as never } } },
      },
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: jsonSchema(api, cmd.output, cmd.name, 'output') as never } } },
        ...errors,
      },
    });
    api.openAPIRegistry.registerPath(route);
    if (cmd.name === 'assets.upload') {
      // Base64 inflates by 4/3; refuse an oversized body before it is buffered, with the same
      // limit the command enforces on the decoded bytes (plus room for the JSON envelope).
      api.use(
        route.path,
        bodyLimit(Math.ceil(deps.assetMaxBytes * (4 / 3)) + 16_384, (c) =>
          c.json(
            {
              error: 'invalid_input',
              message: `The upload body is larger than the ${assetLimitMb} MB asset limit allows. Upload a smaller file or raise ASSET_MAX_BYTES.`,
            },
            413,
          ),
        ),
      );
    } else {
      // Refuse an oversized body before the executor sees it (and before authentication reads it).
      api.use(
        route.path,
        bodyLimit(REST_MAX_BODY, (c) =>
          c.json({ error: 'payload_too_large', message: `Requests are limited to ${REST_MAX_BODY / (1024 * 1024)} MB.` }, 413),
        ),
      );
    }
    api.post(route.path, async (c) => {
      const bearer = c.req.header('authorization')?.match(/^Bearer (amk_\S+)$/)?.[1];
      let principal: Principal | null;
      if (bearer) {
        principal = await principalFromApiToken(deps.db, bearer);
        if (!principal) throw new AppError('unauthorized', 'This API token is unknown, revoked or expired.');
      } else {
        principal = await principalFromSession(deps.auth, deps.db, c.req.raw.headers);
        if (!principal) throw new AppError('unauthorized', 'Sign in first, or pick a workspace you are a member of with X-Workspace-Id.');
        // A cookie is attached to a cross-site request by the browser; only JSON from this origin may
        // write. Bearer tokens are not attached by a page and skip this check.
        const refused = csrfRefusal(c.req.raw, deps.origin);
        if (refused) return refused;
      }
      // Tokens and OAuth connections act in the brand they were created for; the header may pick
      // a workspace only for a session (#187).
      assertWorkspaceHeader(principal, c.req.raw.headers);
      const body = await c.req.json().catch(() => ({}));
      const idempotencyKey = c.req.header('idempotency-key');
      if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > IDEMPOTENCY_KEY_MAX))
        throw new AppError('invalid_input', `The idempotency-key header must be 1 to ${IDEMPOTENCY_KEY_MAX} characters.`);
      const out = await deps.executor.execute(cmd, body, principal, { surface: 'rest', idempotencyKey });
      return c.json(out as object, 200);
    });
  }
  api.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'Agentic Marketing API', version: VERSION } });
  return api;
}
