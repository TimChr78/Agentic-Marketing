// Better Auth skips its origin check when NODE_ENV is "test" (`isTest()` in @better-auth/core), so
// this file asks for the production behaviour before the auth package is loaded. Everything else is
// the normal test harness. It proves the docs/identity.md command now carries the Origin header
// the CSRF check requires (#929).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { startTestServer as startServer, User } from './harness';

process.env.NODE_ENV = 'production';
// Vitest sets TEST=true, which @better-auth/core also reads as "test".
process.env.TEST = 'false';
const { startTestServer, testPort } = await import('./harness');

const PORT = testPort(3479);
const IDP = 'https://idp.example.com';

let t: Awaited<ReturnType<typeof startServer>>;
let owner: User;
let workspaceId = '';

beforeAll(async () => {
  t = await startTestServer('test_sso_origin', PORT, { TRUSTED_ORIGINS: IDP });
  owner = await t.signUp(`sso-origin-${Date.now()}@example.com`);
  workspaceId = await t.workspaceWith([[owner, 'owner']], 'none');
}, 90_000);
afterAll(() => t?.close());

const registration = (providerId: string) =>
  JSON.stringify({
    providerId,
    issuer: IDP,
    domain: 'acme.example',
    workspaceId,
    defaultRole: 'marketer',
    oidcConfig: {
      clientId: 'docs-example',
      clientSecret: 'docs-example-secret',
      pkce: true,
      skipDiscovery: true,
      discoveryEndpoint: `${IDP}/.well-known/openid-configuration`,
      authorizationEndpoint: `${IDP}/authorize`,
      tokenEndpoint: `${IDP}/token`,
      jwksEndpoint: `${IDP}/jwks`,
    },
  });

describe('the SSO registration curl (#929)', () => {
  it('is refused without Origin and accepted with the PUBLIC_URL origin', async () => {
    const withoutOrigin = await fetch(`${t.base}/api/auth/sso/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: registration('acme-without-origin'),
    });
    expect(withoutOrigin.status).toBe(403);
    expect(await withoutOrigin.json()).toMatchObject({ code: 'MISSING_OR_NULL_ORIGIN' });

    const withOrigin = await fetch(`${t.base}/api/auth/sso/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base },
      body: registration('acme-with-origin'),
    });
    expect(withOrigin.status).not.toBe(403);
    expect(withOrigin.status).toBe(200);
  });
});
