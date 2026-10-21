import type { JWTPayload } from 'jose';
import { auth } from './auth';
import { adminPool } from './db/pool';
import { rolePermissions } from './commands';
import type { Principal } from './registry';

async function membership(userId: string, workspaceId?: string) {
  const { rows } = await adminPool.query<{ workspace_id: string; role: string }>(
    `SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 ${workspaceId ? 'AND workspace_id = $2' : ''} ORDER BY workspace_id LIMIT 1`,
    workspaceId ? [userId, workspaceId] : [userId],
  );
  return rows[0];
}

/** A person using the UI or REST API with a session cookie. */
export async function principalFromSession(headers: Headers): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const m = await membership(session.user.id, headers.get('x-workspace-id') ?? undefined);
  if (!m) return null;
  return { type: 'user', userId: session.user.id, workspaceId: m.workspace_id, scopes: new Set(rolePermissions[m.role]) };
}

/**
 * An MCP client acting for a user. Effective permissions are the user's role
 * permissions intersected with the scopes the user granted to this client.
 */
export async function principalFromToken(claims: JWTPayload): Promise<Principal | null> {
  const userId = claims.sub;
  if (!userId) return null;
  const m = await membership(userId);
  if (!m) return null;
  const granted = new Set(String(claims.scope ?? '').split(' ').filter(Boolean));
  const scopes = new Set(rolePermissions[m.role].filter((p) => granted.has(p)));
  const clientId = String(claims.azp ?? claims.client_id ?? 'unknown-client');
  return { type: 'agent', userId, clientId, workspaceId: m.workspace_id, scopes };
}
