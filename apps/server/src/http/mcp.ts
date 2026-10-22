import { type Auth, principalFromAccessToken, principalFromApiToken } from '@agentic-marketing/auth';
import { type Executor, type Principal, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { requireMcpAuth } from '@better-auth/mcp';
import { type AuthInfo, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { commands } from '../registry';

// MCP surface (spec 2026-07-28, SDK v2): a stateless server per request for the authenticated
// principal. Each command the principal may run becomes a tool; humans-only commands are not
// listed. With `stepUp` (OAuth clients), tools the person's role allows but the client was not
// granted are listed too: calling one answers 403 insufficient_scope, so the client can ask the
// person for that scope and retry (scope step-up). The in-app copilot uses the same server.

/** The permission a tool call needs that the principal's role has but the client was not granted. */
export function missingScope(principal: Principal, toolName: string) {
  const cmd = commands.find((c) => c.name === toolName);
  if (!cmd?.permission || cmd.humansOnly || principal.permissions.has(cmd.permission)) return null;
  return ROLE_PERMISSIONS[principal.role].includes(cmd.permission) ? cmd.permission : null;
}

export function mcpServerFor(principal: Principal, executor: Executor, opts: { stepUp?: boolean } = {}) {
  const server = new McpServer({ name: 'agentic-marketing', version: '0.1.0' });
  for (const cmd of commands) {
    if (cmd.humansOnly || !cmd.permission) continue;
    const granted = principal.permissions.has(cmd.permission);
    if (!granted && !(opts.stepUp && missingScope(principal, cmd.name))) continue;
    server.registerTool(
      cmd.name,
      {
        title: cmd.title,
        description: granted
          ? cmd.description
          : `${cmd.description}\n\nNeeds the "${cmd.permission}" permission, which this connection was not granted: calling it asks the person to grant it.`,
        inputSchema: cmd.input,
        outputSchema: cmd.output,
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
          return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
        } catch (err) {
          if (err instanceof AppError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }] };
          throw err;
        }
      },
    );
  }
  return server;
}

export function mcpEndpoint(deps: { auth: Auth; db: Db; executor: Executor; resource: string }) {
  const handler = createMcpHandler(({ authInfo }) =>
    mcpServerFor(authInfo!.extra!.principal as Principal, deps.executor, { stepUp: authInfo!.extra!.stepUp === true }),
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
    const needed = [...new Set(calls.map((m) => missingScope(principal, String(m.params?.name ?? ''))).filter((p) => p !== null))];
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
    const authInfo: AuthInfo = { token: '', clientId: principal.clientId!, scopes: [...principal.permissions], extra: { principal } };
    return handler.fetch(request, { authInfo });
  };
}
