import { defineCommand } from '@agentic-marketing/commands';
import type { Db, Role } from '@agentic-marketing/db';
import { sso } from '@better-auth/sso';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { z } from 'zod';

// Single sign-on (OIDC, SAML) through @better-auth/sso. A provider belongs to a workspace: whoever
// signs in through it becomes a member with the provider's default role (unless SCIM manages
// the workspace's members). Providers are set up through the plugin's own endpoints with a
// session (people only); the guard below lets only owners and admins of that workspace do it.
// With `enforced`, people of the provider's (verified) domain cannot use passwords any more.

export interface SsoConfig {
  /** Require a DNS TXT record before a provider's domain is used (default true; tests turn it off). */
  domainVerification?: boolean;
}

const MANAGED_ROLES: Role[] = ['admin', 'marketer', 'approver', 'viewer'];
const ADMIN_PATHS = [
  '/sso/register',
  '/sso/update-provider',
  '/sso/delete-provider',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
];

interface ProviderRow {
  provider_id: string;
  workspace_id: string;
  domain: string;
  default_role: Role;
  enforced: boolean;
}

async function workspaceRole(db: Db, userId: string, workspaceId: string) {
  const { rows } = await db.admin.query<{ role: Role }>('SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    userId,
    workspaceId,
  ]);
  return rows[0]?.role;
}

async function providerById(db: Db, providerId: string) {
  const { rows } = await db.admin.query<ProviderRow>(
    `SELECT "providerId" AS provider_id, "workspaceId" AS workspace_id, domain, "defaultRole" AS default_role, enforced
     FROM "ssoProvider" WHERE "providerId" = $1`,
    [providerId],
  );
  return rows[0];
}

export function ssoPlugin(db: Db, config: SsoConfig) {
  const verification = config.domainVerification ?? true;
  return sso({
    domainVerification: { enabled: verification },
    provisionUserOnEveryLogin: true,
    schema: {
      ssoProvider: {
        additionalFields: {
          workspaceId: { type: 'string', required: true, input: true },
          defaultRole: { type: 'string', required: false, defaultValue: 'viewer', input: true },
          enforced: { type: 'boolean', required: false, defaultValue: false, input: true },
        },
      },
    },
    async provisionUser({ user, provider }) {
      const p = await providerById(db, provider.providerId);
      if (!p) return;
      // SCIM, when on, is the source of truth for who is a member.
      const { rows } = await db.admin.query('SELECT 1 FROM scim_settings WHERE workspace_id = $1 AND enabled', [p.workspace_id]);
      if (rows.length) return;
      await db.admin.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [p.workspace_id, user.id, MANAGED_ROLES.includes(p.default_role) ? p.default_role : 'viewer'],
      );
    },
  });
}

/** Who may set up providers, and no passwords for domains whose provider is enforced. */
export function ssoGuard(db: Db, config: SsoConfig) {
  return createAuthMiddleware(async (ctx) => {
    if (ADMIN_PATHS.includes(ctx.path)) {
      const session = await getSessionFromCtx(ctx);
      if (!session) throw new APIError('UNAUTHORIZED');
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const providerId = String(body.providerId ?? ctx.query?.providerId ?? '');
      const workspaceId =
        ctx.path === '/sso/register' ? String(body.workspaceId ?? '') : ((await providerById(db, providerId))?.workspace_id ?? '');
      if (!workspaceId) throw new APIError('BAD_REQUEST', { message: 'Name the workspace (workspaceId) the provider signs people into.' });
      if (ctx.path !== '/sso/register' && body.workspaceId !== undefined && body.workspaceId !== workspaceId)
        throw new APIError('BAD_REQUEST', { message: 'A provider stays in its workspace; register a new one for another workspace.' });
      const role = await workspaceRole(db, session.user.id, workspaceId);
      if (role !== 'owner' && role !== 'admin')
        throw new APIError('FORBIDDEN', { message: 'Only owners and admins of the workspace can set up single sign-on.' });
      if (body.defaultRole !== undefined && !MANAGED_ROLES.includes(body.defaultRole as Role))
        throw new APIError('BAD_REQUEST', {
          message: `defaultRole must be one of ${MANAGED_ROLES.join(', ')}; owners are made by people.`,
        });
      return;
    }
    if (ctx.path === '/sign-in/email' || ctx.path === '/sign-up/email') {
      const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase();
      const domain = email.split('@')[1];
      if (!domain) return;
      const { rows } = await db.admin.query(
        `SELECT 1 FROM "ssoProvider" WHERE lower(domain) = $1 AND enforced ${config.domainVerification === false ? '' : 'AND "domainVerified"'}`,
        [domain],
      );
      if (rows.length) throw new APIError('FORBIDDEN', { message: `${domain} signs in with single sign-on. Use "Sign in with SSO".` });
    }
  });
}

export const listSsoProviders = defineCommand({
  name: 'sso.list',
  title: 'Single sign-on providers',
  description:
    'The OIDC and SAML identity providers people of this workspace sign in with: domain, whether it is verified, the role new people get and whether passwords are turned off for the domain. Set them up as an owner or admin under Settings (the /api/auth/sso endpoints).',
  input: z.object({}),
  output: z.object({
    providers: z.array(
      z.object({
        providerId: z.string(),
        type: z.enum(['oidc', 'saml']),
        issuer: z.string(),
        domain: z.string(),
        domainVerified: z.boolean(),
        defaultRole: z.string(),
        enforced: z.boolean(),
      }),
    ),
  }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_i, ctx) => ({ providers: await ctx.services.directory.ssoProviders(ctx.principal.workspaceId) }),
});
