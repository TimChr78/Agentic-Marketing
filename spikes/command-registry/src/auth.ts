import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { config } from './config';
import { adminPool } from './db/pool';
import { allScopes } from './commands';

export const mcpResource = `${config.baseUrl}/mcp`;

// Better Auth is both the login system for people and the OAuth 2.1 authorization server
// for MCP clients. Dynamic client registration is on so MCP clients can self-register.
export const authOptions = {
  baseURL: config.baseUrl,
  secret: config.secret,
  database: adminPool,
  emailAndPassword: { enabled: true },
  plugins: [
    jwt(),
    mcp({
      loginPage: '/login',
      consentPage: '/consent',
      resource: mcpResource,
      scopes: ['openid', 'profile', 'email', 'offline_access', ...allScopes],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultScopes: ['openid', 'offline_access', 'journeys:read'],
      clientRegistrationAllowedScopes: ['openid', 'profile', 'email', 'offline_access', ...allScopes],
    }),
  ],
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);
