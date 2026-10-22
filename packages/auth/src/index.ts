import { agentPrincipal, PERMISSIONS, type Principal, userPrincipal } from '@agentic-marketing/commands';
import type { Db, Role } from '@agentic-marketing/db';
import { type CimdOptions, cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import type { JWTPayload } from 'jose';

export interface AuthConfig {
  /** Public URL of the server, e.g. https://marketing.example.com */
  baseUrl: string;
  secret: string;
  db: Db;
  trustedOrigins?: string[];
  /** Overrides for Client ID Metadata Document discovery (tests use a stub transport). */
  cimd?: Partial<CimdOptions>;
}

/** Scopes an MCP client can be granted; permissions double as scopes. Agents get read-only unless the person grants more. */
export const AGENT_DEFAULT_SCOPES = ['openid', 'offline_access', 'artifacts:read'];

export function authOptions(config: AuthConfig) {
  return {
    baseURL: config.baseUrl,
    secret: config.secret,
    database: config.db.admin,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    plugins: [
      jwt(),
      // OAuth 2.1 authorization server for MCP clients (validated in spike 1).
      mcp({
        loginPage: '/login',
        consentPage: '/consent',
        resource: `${config.baseUrl}/mcp`,
        scopes: ['openid', 'profile', 'email', 'offline_access', ...PERMISSIONS],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: AGENT_DEFAULT_SCOPES,
        clientRegistrationAllowedScopes: ['openid', 'profile', 'email', 'offline_access', ...PERMISSIONS],
      }),
      // Client ID Metadata Documents: clients that identify themselves with an HTTPS URL instead of
      // registering (the MCP 2026-07-28 preference). The Node transport pins DNS to public addresses.
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28', ...config.cimd }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config));
}
export type Auth = ReturnType<typeof createAuth>;

export async function migrateAuth(config: AuthConfig) {
  const { runMigrations } = await getMigrations(authOptions(config));
  await runMigrations();
}

async function membership(db: Db, userId: string, workspaceId?: string | null) {
  const { rows } = await db.admin.query<{ workspace_id: string; role: Role }>(
    `SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 ${workspaceId ? 'AND workspace_id = $2' : ''} ORDER BY created_at LIMIT 1`,
    workspaceId ? [userId, workspaceId] : [userId],
  );
  return rows[0];
}

/** A person using the UI or REST API with a session cookie. `X-Workspace-Id` picks a workspace when they have several. */
export async function principalFromSession(auth: Auth, db: Db, headers: Headers): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const m = await membership(db, session.user.id, headers.get('x-workspace-id'));
  return m ? userPrincipal(session.user.id, m.workspace_id, m.role) : null;
}

/** An MCP client acting for a person: role permissions ∩ scopes the person granted to the client. */
export async function principalFromAccessToken(db: Db, claims: JWTPayload): Promise<Principal | null> {
  if (!claims.sub) return null;
  const m = await membership(db, claims.sub);
  if (!m) return null;
  const scopes = String(claims.scope ?? '')
    .split(' ')
    .filter(Boolean);
  return agentPrincipal(claims.sub, String(claims.azp ?? claims.client_id ?? 'unknown-client'), m.workspace_id, m.role, scopes);
}
export * from './members';
export * from './tokens';
