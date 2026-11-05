import { PERMISSIONS, type Permission, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db, Role } from '@agentic-marketing/db';

// One brand per OAuth connection (#187). The consent page writes the chosen workspace for the
// current session; the OAuth provider reads it as the grant's reference id, and the issued access
// token carries it as the `workspace_id` claim. The selection only records a pending choice; the
// membership and role check here decides whether the person may make it.

export interface OAuthWorkspaceChoice {
  id: string;
  name: string;
  role: Role;
}

/** The permission scopes in an OAuth scope string (identity scopes such as `openid` are ignored). */
export function permissionScopes(scope: string | undefined): Permission[] {
  return (scope ?? '').split(' ').filter((s): s is Permission => (PERMISSIONS as readonly string[]).includes(s));
}

/** Records the workspace the person chose on the consent page, after checking they may grant it. */
export async function chooseOAuthWorkspace(
  db: Db,
  input: { sessionId: string; userId: string; workspaceId: string; scope?: string },
): Promise<OAuthWorkspaceChoice> {
  const { rows } = await db.admin.query<{ id: string; name: string; role: Role }>(
    `SELECT w.id, w.name, m.role
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND m.workspace_id = $2`,
    [input.userId, input.workspaceId],
  );
  const m = rows[0];
  if (!m) throw new AppError('forbidden', 'You are not a member of that workspace. Choose a brand you belong to.');
  const extra = permissionScopes(input.scope).filter((p) => !ROLE_PERMISSIONS[m.role].includes(p));
  if (extra.length)
    throw new AppError(
      'forbidden',
      `Your role (${m.role}) in ${m.name} cannot grant ${extra.join(', ')}. Ask an owner or admin there to change your role, or choose another brand.`,
    );
  await db.admin.query(
    `INSERT INTO oauth_workspace_selections (session_id, workspace_id) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET workspace_id = excluded.workspace_id, updated_at = now()`,
    [input.sessionId, input.workspaceId],
  );
  return m;
}

/**
 * The workspace to bind a consent to: the choice made for this session, else the only membership a
 * person has. A person with several memberships and no choice gets `undefined`; the consent page
 * asks, and the issued token without the claim is refused rather than silently acting in one brand.
 */
export async function consentWorkspaceId(db: Db, userId: string, sessionId: string): Promise<string | undefined> {
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM oauth_workspace_selections WHERE session_id = $1',
    [sessionId],
  );
  const chosen = rows[0]?.workspace_id;
  const memberships = await db.admin.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  if (chosen && memberships.rows.some((m) => m.workspace_id === chosen)) return chosen;
  if (chosen) await db.admin.query('DELETE FROM oauth_workspace_selections WHERE session_id = $1', [sessionId]);
  return memberships.rows.length === 1 ? memberships.rows[0].workspace_id : undefined;
}

/** The workspace a credential is bound to, with the role the person has there, or undefined. */
export async function boundMembership(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<{ workspace_id: string; role: Role } | undefined> {
  const { rows } = await db.admin.query<{ workspace_id: string; role: Role }>(
    'SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2',
    [userId, workspaceId],
  );
  return rows[0];
}
