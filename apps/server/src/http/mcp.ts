import { type Auth, principalFromAccessToken, principalFromApiToken } from '@agentic-marketing/auth';
import { type CommandDef, type Executor, type Principal, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { requireMcpAuth } from '@better-auth/mcp';
import { type AuthInfo, createMcpHandler, McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { commands } from '../registry';
import { MCP_GUIDE_URI, MCP_INSTRUCTIONS } from './mcpInstructions';

// MCP surface (spec 2026-07-28, SDK v2): a stateless server per request for the authenticated
// principal. Each command the principal may run becomes a tool; humans-only commands are not
// listed. With `stepUp` (OAuth clients), tools the person's role allows but the client was not
// granted are listed too: calling one answers 403 insufficient_scope, so the client can ask the
// person for that scope and retry (scope step-up). The in-app copilot uses the same server.

export type McpTextContent = 'json' | 'summary';
export type McpToolNameStyle = 'dotted' | 'underscore';

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
export function mcpInputSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  return {
    '~standard': {
      version: standard.version,
      vendor: standard.vendor,
      jsonSchema: standard.jsonSchema,
      validate: (value: unknown) => ({ value }),
    },
  };
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
  const server = new McpServer({ name: 'agentic-marketing', version: '0.1.2' }, { instructions: MCP_INSTRUCTIONS });
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
  for (const cmd of commands) {
    if (cmd.humansOnly || !cmd.permission) continue;
    const toolName = mcpToolName(cmd.name, style);
    const granted = principal.permissions.has(cmd.permission);
    if (!granted && !(opts.stepUp && missingScope(principal, toolName, style))) continue;
    server.registerTool(
      toolName,
      {
        title: cmd.title,
        description: granted
          ? cmd.description
          : `${cmd.description}\n\nNeeds the "${cmd.permission}" permission, which this connection was not granted: calling it asks the person to grant it.`,
        inputSchema: mcpInputSchema(cmd.input),
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
          const out = await executor.execute(cmd, input, principal, { surface: 'mcp' });
          return {
            content: [
              { type: 'text' as const, text: opts.textContent === 'summary' ? summarizeOutput(cmd.name, out) : JSON.stringify(out) },
            ],
            structuredContent: out as Record<string, unknown>,
          };
        } catch (err) {
          if (err instanceof AppError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }] };
          throw err;
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
        return Response.json({ error: 'no_workspace', message: 'The signed-in person is not a member of any workspace.' }, { status: 403 });
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
    // The server (and its tool list) is built per request from this principal, so a narrowed token
    // loses tools at once rather than keeping a cached server from an earlier request.
    const denial = await apiTokenDenial(request, principal);
    if (denial) return denial;
    const authInfo: AuthInfo = { token: '', clientId: principal.clientId!, scopes: [...principal.permissions], extra: { principal } };
    return handler.fetch(request, { authInfo });
  };
}
