import { type Auth, principalFromAccessToken } from '@agentic-marketing/auth';
import type { Executor, Principal } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { requireMcpAuth } from '@better-auth/mcp';
import { type AuthInfo, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { commands } from '../registry';

// MCP surface (spec 2026-07-28, SDK v2): a stateless server per request for the authenticated
// principal. Each command the principal may run becomes a tool; humans-only commands and tools
// outside the granted permissions are not listed.
export function mcpEndpoint(deps: { auth: Auth; db: Db; executor: Executor; resource: string }) {
  const build = (principal: Principal) => {
    const server = new McpServer({ name: 'agentic-marketing', version: '0.1.0' });
    for (const cmd of commands) {
      if (cmd.humansOnly || !cmd.permission || !principal.permissions.has(cmd.permission)) continue;
      server.registerTool(
        cmd.name,
        {
          title: cmd.title,
          description: cmd.description,
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
            const out = await deps.executor.execute(cmd, input, principal, { surface: 'mcp' });
            return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
          } catch (err) {
            if (err instanceof AppError) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }] };
            throw err;
          }
        },
      );
    }
    return server;
  };

  const handler = createMcpHandler(({ authInfo }) => build(authInfo!.extra!.principal as Principal));

  return requireMcpAuth(
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
        extra: { principal },
      };
      return handler.fetch(request, { authInfo });
    },
    { resource: deps.resource },
  );
}
