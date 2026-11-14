import { getBusinessContext, listLearnings } from '@agentic-marketing/artifacts';
import { type Auth, principalFromAccessToken, principalFromApiToken, workspaceHeaderConflict } from '@agentic-marketing/auth';
import { type CommandDef, type Executor, IDEMPOTENCY_KEY_MAX, type Principal, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { requireMcpAuth } from '@better-auth/mcp';
import { type AuthInfo, createMcpHandler, McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { commands } from '../registry';
import { VERSION } from '../version';
import { MCP_BUSINESS_CONTEXT_URI, MCP_GUIDE_URI, MCP_INSTRUCTIONS, MCP_LEARNINGS_URI } from './mcpInstructions';

// MCP surface (spec 2026-07-28, SDK v2): a stateless server per request for the authenticated
// principal. Each command the principal may run becomes a tool; humans-only commands are not
// listed. With `stepUp` (OAuth clients), tools the person's role allows but the client was not
// granted are listed too: calling one answers 403 insufficient_scope, so the client can ask the
// person for that scope and retry (scope step-up). The in-app copilot uses the same server.

export type McpTextContent = 'json' | 'summary';
export type McpToolNameStyle = 'dotted' | 'underscore';

// JSON-RPC calls carry tool arguments and a short prompt; 1 MB is far above any real call and
// bounds the endpoint before the OAuth/API-token handling reads the request.
export const MCP_MAX_BODY = 1024 * 1024;

/** Tool names are command names by default; some clients only accept letters, digits and underscores. */
export function mcpToolName(commandName: string, style: McpToolNameStyle): string {
  return style === 'underscore' ? commandName.replaceAll('.', '_') : commandName;
}

/** The command behind a tool name, for calls and scope challenges. */
export function commandForMcpTool(toolName: string, style: McpToolNameStyle): CommandDef | undefined {
  return commands.find((c) => (style === 'underscore' ? mcpToolName(c.name, style) : c.name) === toolName);
}

/**
 * The SDK validates arguments with the input schema and passes only the parsed value on, which
 * would strip unknown keys before the executor can reject or report them. Keep the JSON Schema
 * (so tools/list still advertises the command input) but hand the raw arguments to the executor,
 * which is the single place that parses and reports unknown input keys.
 */
export function mcpInputSchema(schema: StandardSchemaWithJSON, opts: { idempotencyKey?: boolean } = {}): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  return {
    '~standard': {
      version: standard.version,
      vendor: standard.vendor,
      jsonSchema: opts.idempotencyKey
        ? {
            input: (options) => addIdempotencyKey(standard.jsonSchema.input(options)),
            output: (options) => standard.jsonSchema.output(options),
          }
        : standard.jsonSchema,
      validate: (value: unknown) => ({ value }),
    },
  };
}

/** Adds the optional retry key to a write tool's advertised input schema (#906). */
function addIdempotencyKey(json: Record<string, unknown>): Record<string, unknown> {
  const properties = json.properties && typeof json.properties === 'object' ? (json.properties as Record<string, unknown>) : {};
  return {
    ...json,
    properties: {
      ...properties,
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: IDEMPOTENCY_KEY_MAX,
        description:
          'Optional: reuse the same key when retrying this write so it runs once; a new key would run it again (see the idempotency contract in docs/integrations.md).',
      },
    },
  };
}

/** True when the command already declares its own `idempotencyKey` input field (a send, an enrollment). */
function declaresIdempotencyKey(schema: CommandDef['input']): boolean {
  return schema instanceof z.ZodObject && Object.hasOwn(schema.shape, 'idempotencyKey');
}

/**
 * Commands validate their own output, but the executor may add top-level `warnings` for unknown
 * input keys. The SDK validates structuredContent against the advertised output schema, so allow
 * that optional field. Commands that already define warnings (draft warnings, provider warnings)
 * keep their own schema.
 */
export function mcpOutputSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  if (schema instanceof z.ZodObject && !('warnings' in schema.shape)) {
    return schema.extend({ warnings: z.array(z.string()).optional() }) as unknown as StandardSchemaWithJSON;
  }
  return schema;
}

/** One-line text for `MCP_TEXT_CONTENT=summary`; structuredContent still carries the full result. */
export function summarizeOutput(commandName: string, output: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(output)) {
    parts.push(`${output.length} items`);
  } else if (output && typeof output === 'object') {
    for (const [key, value] of Object.entries(output)) {
      if (Array.isArray(value)) parts.push(`${value.length} ${key}`);
      else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) parts.push(`${key}=${String(value)}`);
    }
  }
  const summary = `${commandName}: ${parts.length ? parts.join(', ') : 'ok'}`;
  return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
}

/** The permission a tool call needs that the principal's role has but the client was not granted. */
export function missingScope(principal: Principal, toolName: string, style: McpToolNameStyle = 'dotted') {
  const cmd = commandForMcpTool(toolName, style);
  if (!cmd?.permission || cmd.humansOnly || principal.permissions.has(cmd.permission)) return null;
  return ROLE_PERMISSIONS[principal.role].includes(cmd.permission) ? cmd.permission : null;
}

export function mcpServerFor(
  principal: Principal,
  executor: Executor,
  opts: { stepUp?: boolean; textContent?: McpTextContent; toolNameStyle?: McpToolNameStyle } = {},
) {
  const style = opts.toolNameStyle ?? 'dotted';
  const server = new McpServer({ name: 'agentic-marketing', version: VERSION }, { instructions: MCP_INSTRUCTIONS });
  server.registerResource(
    'guide',
    MCP_GUIDE_URI,
    {
      title: 'Agent guide',
      description: 'How to draft, validate, request publishing, handle dependencies and protect privacy.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: MCP_INSTRUCTIONS, mimeType: 'text/markdown' }] }),
  );
  // The published brief every agent starts from (#227). The command enforces artifacts:read, so
  // only offer the resource to a principal that may read it.
  if (principal.permissions.has('artifacts:read')) {
    server.registerResource(
      'business-context',
      MCP_BUSINESS_CONTEXT_URI,
      {
        title: 'Business context',
        description: 'The published brief: what the business offers and to whom, the voice, claims to avoid and legal lines.',
        mimeType: 'application/json',
      },
      async (uri) => {
        const out = await executor.execute(getBusinessContext, {}, principal, { surface: 'mcp' });
        return { contents: [{ uri: uri.href, text: JSON.stringify(out), mimeType: 'application/json' }] };
      },
    );
    // The active conclusions with their evidence (#311). The command enforces artifacts:read, so
    // only offer the resource to a principal that may read it.
    server.registerResource(
      'learnings',
      MCP_LEARNINGS_URI,
      {
        title: 'Learnings',
        description: 'Active conclusions from subject tests, holdouts and experiences, with the numbers behind them.',
        mimeType: 'application/json',
      },
      async (uri) => {
        const out = await executor.execute(listLearnings, {}, principal, { surface: 'mcp' });
        return { contents: [{ uri: uri.href, text: JSON.stringify(out), mimeType: 'application/json' }] };
      },
    );
  }
  for (const cmd of commands) {
    if (cmd.humansOnly || !cmd.permission) continue;
    const toolName = mcpToolName(cmd.name, style);
    const granted = principal.permissions.has(cmd.permission);
    if (!granted && !(opts.stepUp && missingScope(principal, toolName, style))) continue;
    // A write takes the retry key as its own argument unless the command already has one for its
    // handler (a send's `idempotencyKey`, a bulk enrollment's): that field keeps its meaning and
    // is not stripped or turned into the executor key (#906).
    const writeKey = cmd.effect !== 'read' && !declaresIdempotencyKey(cmd.input);
    server.registerTool(
      toolName,
      {
        title: cmd.title,
        description: granted
          ? cmd.description
          : `${cmd.description}\n\nNeeds the "${cmd.permission}" permission, which this connection was not granted: calling it asks the person to grant it.`,
        inputSchema: mcpInputSchema(cmd.input, { idempotencyKey: writeKey }),
        outputSchema: mcpOutputSchema(cmd.output),
        annotations: {
          readOnlyHint: cmd.effect === 'read',
          destructiveHint: cmd.effect === 'destructive',
          idempotentHint: cmd.effect === 'read',
          openWorldHint: false,
        },
      },
      async (input: unknown) => {
        try {
          let commandInput = input;
          let idempotencyKey: string | undefined;
          if (writeKey && input && typeof input === 'object' && !Array.isArray(input)) {
            const { idempotencyKey: raw, ...rest } = input as Record<string, unknown>;
            if (raw !== undefined) {
              if (typeof raw !== 'string' || raw.length < 1 || raw.length > IDEMPOTENCY_KEY_MAX)
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({
                        error: 'invalid_input',
                        message: `The idempotencyKey argument must be a string of 1 to ${IDEMPOTENCY_KEY_MAX} characters.`,
                      }),
                    },
                  ],
                };
              idempotencyKey = raw;
            }
            // The key is not part of the command's input: the executor hashes and validates the rest.
            commandInput = rest;
          }
          const out = await executor.execute(cmd, commandInput, principal, {
            surface: 'mcp',
            ...(idempotencyKey ? { idempotencyKey } : {}),
          });
          return {
            content: [
              { type: 'text' as const, text: opts.textContent === 'summary' ? summarizeOutput(cmd.name, out) : JSON.stringify(out) },
            ],
            structuredContent: out as Record<string, unknown>,
          };
        } catch (err) {
          if (err instanceof AppError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }] };
          // An unexpected exception's text can carry SQL, secrets or driver details. The MCP
          // client sees the same fixed failure as the audit log; the original stays on the span.
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'internal', message: 'The command failed with an unexpected error.' }),
              },
            ],
          };
        }
      },
    );
  }
  return server;
}

export function mcpEndpoint(deps: {
  auth: Auth;
  db: Db;
  executor: Executor;
  resource: string;
  textContent?: McpTextContent;
  toolNameStyle?: McpToolNameStyle;
}) {
  const style = deps.toolNameStyle ?? 'dotted';
  const handler = createMcpHandler(({ authInfo }) =>
    mcpServerFor(authInfo!.extra!.principal as Principal, deps.executor, {
      stepUp: authInfo!.extra!.stepUp === true,
      textContent: deps.textContent,
      toolNameStyle: style,
    }),
  );
  const resourceMetadata = `${new URL(deps.resource).origin}/.well-known/oauth-protected-resource${new URL(deps.resource).pathname}`;

  /** A tools/call the client lacks a scope for gets the standard challenge instead of a tool error. */
  async function stepUpChallenge(request: Request, principal: Principal) {
    if (request.method !== 'POST') return null;
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    const calls = (Array.isArray(body) ? body : [body]).filter((m) => m?.method === 'tools/call');
    const needed = [...new Set(calls.map((m) => missingScope(principal, String(m.params?.name ?? ''), style)).filter((p) => p !== null))];
    if (!needed.length) return null;
    const scope = [...new Set([...principal.permissions, ...needed])].join(' ');
    return new Response(
      JSON.stringify({
        error: 'insufficient_scope',
        message: `This connection needs the ${needed.join(', ')} permission. Ask the person to grant it.`,
      }),
      {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadata}", error_description="The ${needed.join(', ')} permission was not granted to this client"`,
        },
      },
    );
  }

  /**
   * API tokens have no scope step-up of their own: their owner edits them. A tool the token no
   * longer has a scope for (after narrowing) fails on the very next call with a tool error that
   * says why. It is a JSON-RPC result, not an HTTP error, so clients keep their session.
   */
  async function apiTokenDenial(request: Request, principal: Principal) {
    if (request.method !== 'POST') return null;
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    if (!body || Array.isArray(body) || body.method !== 'tools/call') return null;
    const cmd = commandForMcpTool(String(body.params?.name ?? ''), style);
    if (!cmd) return null;
    const message = cmd.humansOnly
      ? `${cmd.name} can only be run by a person, not by an API token.`
      : cmd.permission && !principal.permissions.has(cmd.permission)
        ? `This API token does not have the ${cmd.permission} permission. Its owner can add it with apiTokens.update.`
        : null;
    if (!message) return null;
    const error = { code: cmd.humansOnly ? 'forbidden' : 'insufficient_scope', message };
    return Response.json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] },
    });
  }

  const oauth = requireMcpAuth(
    deps.auth,
    async (request, claims) => {
      const principal = await principalFromAccessToken(deps.db, claims);
      if (!principal)
        return Response.json(
          {
            error: 'no_workspace',
            message: 'This connection is not bound to a brand. Reconnect and choose the brand it acts in, or ask for membership of one.',
          },
          { status: 403 },
        );
      const conflict = workspaceHeaderConflict(principal, request.headers);
      if (conflict) return Response.json({ error: 'workspace_mismatch', message: conflict }, { status: 403 });
      const authInfo: AuthInfo = {
        token: '',
        clientId: principal.clientId!,
        scopes: [...principal.permissions],
        expiresAt: claims.exp,
        resource: new URL(deps.resource),
        extra: { principal, stepUp: true },
      };
      return (await stepUpChallenge(request, principal)) ?? handler.fetch(request, { authInfo });
    },
    { resource: deps.resource },
  );
  // API tokens (scripts, n8n) skip OAuth; everything else goes through it.
  return async (request: Request) => {
    const bearer = request.headers.get('authorization')?.match(/^Bearer (amk_\S+)$/)?.[1];
    if (!bearer) return oauth(request);
    const principal = await principalFromApiToken(deps.db, bearer);
    if (!principal)
      return Response.json({ error: 'invalid_token', message: 'This API token is unknown, revoked or expired.' }, { status: 401 });
    const conflict = workspaceHeaderConflict(principal, request.headers);
    if (conflict) return Response.json({ error: 'workspace_mismatch', message: conflict }, { status: 403 });
    // The server (and its tool list) is built per request from this principal, so a narrowed token
    // loses tools at once rather than keeping a cached server from an earlier request.
    const denial = await apiTokenDenial(request, principal);
    if (denial) return denial;
    const authInfo: AuthInfo = { token: '', clientId: principal.clientId!, scopes: [...principal.permissions], extra: { principal } };
    return handler.fetch(request, { authInfo });
  };
}
