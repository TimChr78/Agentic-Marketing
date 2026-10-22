import type { Role } from '@agentic-marketing/db';

/** Permission strings double as OAuth scopes for agents. */
export const PERMISSIONS = [
  'artifacts:read',
  'artifacts:write',
  'artifacts:publish',
  'artifacts:approve',
  'audit:read',
  'secrets:read',
  'secrets:write',
  'workspace:admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  marketer: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'audit:read'],
  approver: ['artifacts:read', 'artifacts:approve', 'audit:read'],
  viewer: ['artifacts:read'],
};

export interface Principal {
  type: 'user' | 'agent';
  /** The person; for agents, the person the agent acts for. */
  userId: string;
  /** OAuth client id when the principal is an agent. */
  clientId?: string;
  workspaceId: string;
  role: Role;
  /** Effective permissions: the role's permissions, intersected with granted scopes for agents. */
  permissions: ReadonlySet<Permission>;
}

export function userPrincipal(userId: string, workspaceId: string, role: Role): Principal {
  return { type: 'user', userId, workspaceId, role, permissions: new Set(ROLE_PERMISSIONS[role]) };
}

export function agentPrincipal(
  userId: string,
  clientId: string,
  workspaceId: string,
  role: Role,
  grantedScopes: Iterable<string>,
): Principal {
  const granted = new Set(grantedScopes);
  return {
    type: 'agent',
    userId,
    clientId,
    workspaceId,
    role,
    permissions: new Set(ROLE_PERMISSIONS[role].filter((p) => granted.has(p))),
  };
}
