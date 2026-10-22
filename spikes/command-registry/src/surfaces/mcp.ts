import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import { auth, mcpResource } from '../auth';
import { commands } from '../commands';
import { CommandError, execute, type Principal } from '../registry';
import { principalFromToken } from '../principal';

// MCP surface: every command becomes a tool, generated from the registry.
// The handler is stateless (MCP 2026-07-28); a fresh McpServer is built per request
// for the authenticated principal.

function buildServer(principal: Principal) {
  const server = new McpServer({ name: 'agentic-marketing', version: '0.0.0' });
  for (const cmd of commands) {
    if (cmd.humansOnly) continue; // agents never see tools they can never run
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
          const out = await execute(cmd, input, principal, { surface: 'mcp' });
          return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
        } catch (err) {
          if (err instanceof CommandError)
            return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: err.code, message: err.message, details: err.details }) }] };
          throw err;
        }
      },
    );
  }
  return server;
}

const handler = createMcpHandler(({ authInfo }) => buildServer(authInfo!.extra!.principal as Principal));

export const mcpEndpoint = requireMcpAuth(
  auth,
  async (request, claims) => {
    const principal = await principalFromToken(claims);
    if (!principal) return new Response(JSON.stringify({ error: 'no_workspace', message: 'This user is not a member of any workspace' }), { status: 403 });
    const authInfo: AuthInfo = {
      token: '',
      clientId: principal.clientId!,
      scopes: [...principal.scopes],
      expiresAt: claims.exp,
      resource: new URL(mcpResource),
      extra: { principal },
    };
    return handler.fetch(request, { authInfo });
  },
  { resource: mcpResource },
);
