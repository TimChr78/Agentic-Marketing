import { createHash, randomBytes } from 'node:crypto';
import { agentPrincipal, PERMISSIONS, type Principal, userPrincipal } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import type { Db, Role } from '@agentic-marketing/db';
import { type CimdOptions, cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { runWithTransaction } from '@better-auth/core/context';
import { mcp } from '@better-auth/mcp';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import type { JWTPayload } from 'jose';
import { agentForCredential, oauthClientName } from './agents';
import { boundMembership, consentWorkspaceId, isWorkspaceReference } from './oauthWorkspace';
import { type SsoConfig, ssoGuard, ssoPlugin } from './sso';

/** Better Auth stores reset tokens under this prefix in its `verification` table. */
const RESET_PREFIX = 'reset-password:';

/** Minutes a reset link stays valid (#191). Long enough to find the mail, short enough to matter. */
export const RESET_PASSWORD_TTL_SECONDS = 45 * 60;

/** The identifier Better Auth stores a reset token under (before hashing). */
export const resetTokenIdentifier = (token: string) => `${RESET_PREFIX}${token}`;

/**
 * The identifier as stored: Better Auth hashes reset-password identifiers at rest (#191), so a
 * database dump or a log of the table never yields a usable link. Only reset tokens are hashed;
 * other verification values keep Better Auth's plain default.
 */
export const hashedResetTokenIdentifier = (token: string) => createHash('sha256').update(resetTokenIdentifier(token)).digest('base64url');

/**
 * Mints a 192-bit random reset verification token, never a user-chosen password (#379).
 * SHA-256 identifier hashing follows Better Auth's verification semantics: the row is
 * written through the auth context's internal adapter, so the configured identifier hashing
 * (`reset-password:` → SHA-256 base64url), expiry and single-use consumption are identical to a
 * token minted by Better Auth's request endpoint. The delivery worker calls this only after the
 * durable request has been claimed and eligibility re-checked; the public request path never does.
 */
export async function mintResetVerification(auth: Auth, userId: string, ttlSeconds: number = RESET_PASSWORD_TTL_SECONDS): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    value: userId,
    identifier: resetTokenIdentifier(token),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
  return token;
}

/** Sends the installation-level reset link. Only accounts with a password are eligible. */
export interface PasswordResetDelivery {
  /** Seconds a link stays valid; Better Auth's `resetPasswordTokenExpiresIn`. */
  ttlSeconds?: number;
  send: (input: { user: { id: string; email: string; name: string }; token: string; request?: Request }) => Promise<void>;
}

export interface AuthConfig {
  /** Public URL of the server, e.g. https://marketing.example.com */
  baseUrl: string;
  secret: string;
  db: Db;
  trustedOrigins?: string[];
  /** Headers with the client IP, in trust order (sign-in rate limits are per IP). */
  clientIpHeaders?: string[];
  /** @deprecated Use `clientIpHeaders`; kept for backwards compatibility. */
  clientIpHeader?: string;
  /** Overrides for Client ID Metadata Document discovery (tests use a stub transport). */
  cimd?: Partial<CimdOptions>;
  /** Single sign-on settings (domain verification). */
  sso?: SsoConfig;
  /**
   * Self-service password reset (#191). Installation-level: the link goes to `PUBLIC_URL`, not a
   * brand domain. Without it Better Auth refuses reset requests, so a host that does not wire it
   * simply has no self-service reset (the CLI stays the break-glass path).
   */
  passwordReset?: PasswordResetDelivery;
}

/** Scopes an MCP client can be granted; permissions double as scopes. Agents get read-only unless the person grants more. */
export const AGENT_DEFAULT_SCOPES = ['openid', 'offline_access', 'artifacts:read'];

/**
 * MCP OAuth requires an HTTPS resource URL; only loopback hosts may use plain HTTP for local
 * development. Anything else (e.g. a LAN address such as http://192.168.1.20:3210) is rejected by
 * the MCP plugin, so callers disable the MCP/OAuth client endpoints instead of weakening the check.
 */
export function isMcpResourceUrlAllowed(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function authOptions(config: AuthConfig) {
  const mcpEnabled = isMcpResourceUrlAllowed(config.baseUrl);
  return {
    baseURL: config.baseUrl,
    secret: config.secret,
    database: config.db.admin,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      ...(config.passwordReset
        ? {
            // A reset revokes every session of that person (#191), so a stolen cookie stops working.
            revokeSessionsOnPasswordReset: true,
            resetPasswordTokenExpiresIn: config.passwordReset.ttlSeconds ?? RESET_PASSWORD_TTL_SECONDS,
            // Better Auth only calls this for an existing account and never puts the token in a
            // log line; the delivery decides who gets mail (password accounts only) and from where.
            sendResetPassword: async (
              { user, token }: { user: { id: string; email: string; name: string }; token: string },
              request?: Request,
            ) => {
              try {
                await config.passwordReset?.send({
                  user: { id: user.id, email: user.email, name: user.name },
                  token,
                  request,
                });
              } catch {
                // Delivery is logged by the host; a provider outage must not turn the neutral
                // "if an account exists, we sent a link" answer into a 500 that reveals it did.
              }
            },
          }
        : {}),
    },
    verification: {
      // Hash reset tokens at rest (#191). Other verification values stay plain, as Better Auth
      // expects to find them by their own identifier.
      storeIdentifier: { default: 'plain', overrides: { [RESET_PREFIX]: 'hashed' } },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: config.clientIpHeaders ?? [config.clientIpHeader ?? 'x-forwarded-for'] },
    },
    hooks: { before: ssoGuard(config.db, config.sso ?? {}) },
    plugins: [
      jwt(),
      // OAuth 2.1 authorization server for MCP clients (validated in spike 1). The plugin rejects
      // plain-HTTP resource URLs outside loopback, so it is only registered when that is allowed.
      ...(mcpEnabled
        ? [
            mcp({
              loginPage: '/login',
              consentPage: '/consent',
              resource: `${config.baseUrl}/mcp`,
              scopes: ['openid', 'profile', 'email', 'offline_access', ...PERMISSIONS],
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              clientRegistrationDefaultScopes: AGENT_DEFAULT_SCOPES,
              clientRegistrationAllowedScopes: ['openid', 'profile', 'email', 'offline_access', ...PERMISSIONS],
              postLogin: {
                // The consent page itself asks which brand, so this hook never redirects. The
                // reference id is the workspace the grant acts in (#187); the consent page writes
                // the choice for the session, and a single-membership person needs no choice.
                page: '/consent',
                shouldRedirect: async () => false,
                consentReferenceId: async ({ user, session }) => consentWorkspaceId(config.db, user.id, session.id),
              },
              // The access token carries the brand, so a later request cannot change it with a
              // header. Refresh tokens keep the reference id and issue the same claim again. An
              // unbound sentinel (no brand chosen for this request) carries no claim, so the
              // credential is refused rather than acting in a brand nobody chose (#456).
              customAccessTokenClaims: ({ referenceId }) => {
                return isWorkspaceReference(referenceId) ? { workspace_id: referenceId } : {};
              },
            }),
            // Client ID Metadata Documents: clients that identify themselves with an HTTPS URL instead of
            // registering (the MCP 2026-07-28 preference). The Node transport pins DNS to public addresses.
            cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28', ...config.cimd }),
          ]
        : []),
      // Single sign-on with OIDC or SAML identity providers, per workspace.
      ssoPlugin(config.db, config.sso ?? {}),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config));
}
export type Auth = ReturnType<typeof createAuth>;

/**
 * Runs `fn` in one transaction on Better Auth's own adapter (#913). Everything an
 * `internalAdapter` call does inside `fn` joins that transaction, so a password write and the
 * session revocation after it commit together or not at all; a failure rolls both back. Better
 * Auth's reset flow uses the same helper, and a call made inside an open transaction joins it.
 */
export async function inAuthTransaction<T>(auth: Auth, fn: () => Promise<T>): Promise<T> {
  const context = await auth.$context;
  return runWithTransaction(context.adapter, fn);
}

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
  const bound = typeof claims.workspace_id === 'string' ? claims.workspace_id : undefined;
  // A connection issued before #187 has no workspace claim: it stays usable only for a person with
  // one membership, so a multi-brand person must reconnect and choose a brand.
  const m = bound ? await boundMembership(db, claims.sub, bound) : await singleMembership(db, claims.sub);
  if (!m) return null;
  const scopes = String(claims.scope ?? '')
    .split(' ')
    .filter(Boolean);
  const clientId = String(claims.azp ?? claims.client_id ?? 'unknown-client');
  const agent = await agentForCredential(db, m.workspace_id, 'oauth_client', clientId, claims.sub, () => oauthClientName(db, clientId));
  return agentPrincipal(claims.sub, clientId, m.workspace_id, m.role, scopes, agent);
}

async function singleMembership(db: Db, userId: string): Promise<{ workspace_id: string; role: Role } | undefined> {
  const { rows } = await db.admin.query<{ workspace_id: string; role: Role }>(
    'SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 ORDER BY created_at LIMIT 2',
    [userId],
  );
  return rows.length === 1 ? rows[0] : undefined;
}

/**
 * A token or OAuth connection is bound to one brand: `X-Workspace-Id` cannot move it. Sessions are
 * the only principals that may use the header, so a mismatch here is a clear refusal rather than a
 * silently ignored header.
 */
export function workspaceHeaderConflict(principal: Principal, headers: Headers): string | null {
  if (principal.type !== 'agent') return null;
  const requested = headers.get('x-workspace-id');
  if (!requested || requested === principal.workspaceId) return null;
  return 'This credential is bound to one brand. X-Workspace-Id cannot switch it; create a separate token or connection for the other brand.';
}

/** Throws the refusal above, for surfaces that already turn AppErrors into responses. */
export function assertWorkspaceHeader(principal: Principal, headers: Headers): void {
  const conflict = workspaceHeaderConflict(principal, headers);
  if (conflict) throw new AppError('forbidden', conflict);
}
export * from './agentEvents';
export * from './agents';
export * from './hostedAgents';
export * from './hostedSchedule';
export * from './members';
export * from './oauthWorkspace';
export * from './scim';
export * from './sso';
export * from './tokens';
