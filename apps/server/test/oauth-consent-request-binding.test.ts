import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieOf, PASSWORD, startTestServer, TestOAuthProvider, testPort, type User } from './harness';

// #456: two consent tabs share one browser session. The brand choice must belong to the exact
// authorization request (client, redirect, state, PKCE), never to the session, so tab A cannot
// bind its grant to the brand chosen in tab B.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';

beforeAll(async () => {
  t = await startTestServer('test_oauth_request_binding', testPort(3596));
  owner = await t.signUp(`consent-race-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']], 'none');
  wsB = await t.workspaceWith([[owner, 'owner']], 'none');
}, 120_000);
afterAll(() => t?.close());

/** The authorization URL a fresh MCP client is sent to. */
async function authorizationUrl(): Promise<{ url: URL; provider: TestOAuthProvider; transport: StreamableHTTPClientTransport }> {
  const provider = new TestOAuthProvider();
  const transport = new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), { authProvider: provider });
  const failure = await new Client({ name: 't', version: '0' }).connect(transport).then(
    () => null,
    (e) => e,
  );
  if (!(failure instanceof UnauthorizedError)) throw new Error(`expected an authorization challenge, got ${failure}`);
  return { url: provider.authorizationUrl!, provider, transport };
}

const redirectOf = async (res: Response) => {
  const location =
    res.headers.get('location') ??
    (
      await res
        .clone()
        .json()
        .catch(() => ({}))
    ).url;
  return new URL(location, t.base);
};

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;

describe('consent brand selection is bound to its authorization request (#456)', () => {
  it('does not let one tab’s choice bind the other tab’s grant, and keeps it across refresh', async () => {
    const [a, b] = await Promise.all([authorizationUrl(), authorizationUrl()]);

    // Both tabs start at sign-in; the person signs in once.
    const loginA = await redirectOf(await fetch(a.url, { redirect: 'manual', headers: { accept: 'application/json' } }));
    expect(loginA.pathname).toBe('/login');
    const signIn = await fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email: owner.email, password: PASSWORD, oauth_query: loginA.search.slice(1) }),
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);
    const consentA = new URL((await signIn.json()).url, t.base);
    expect(consentA.pathname).toBe('/consent');

    // Tab B's authorize request now finds the signed-in session and lands on its own consent query.
    const consentB = await redirectOf(await fetch(b.url, { redirect: 'manual', headers: { accept: 'application/json', cookie } }));
    expect(consentB.pathname).toBe('/consent');
    expect(consentB.search).not.toBe(consentA.search);

    const choose = async (workspaceId: string, query: string) => {
      const res = await fetch(`${t.base}/api/oauth/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: t.base, cookie },
        body: JSON.stringify({ workspaceId, scope: 'artifacts:read', oauthQuery: query }),
      });
      expect(res.status).toBe(200);
    };
    // Interleave: A chooses brand A, then B chooses brand B before A consents.
    await choose(wsA, consentA.search.slice(1));
    await choose(wsB, consentB.search.slice(1));

    const consent = async (query: URLSearchParams) => {
      const res = await fetch(`${t.base}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: t.base, cookie },
        // Everything requested (identity scopes included), as the consent page does.
        body: JSON.stringify({ accept: true, scope: query.get('scope') ?? 'artifacts:read', oauth_query: query.toString() }),
      });
      const body = (await res.json()) as { url?: string; message?: string };
      expect(body.url, body.message).toBeTruthy();
      return new URL(body.url!, t.base);
    };

    // Tab A consents after tab B's choice: it must still act in brand A.
    await a.transport.finishAuth((await consent(consentA.searchParams)).searchParams);
    expect(claimsOf(a.provider.tokenSet.access_token)).toMatchObject({ workspace_id: wsA });

    await b.transport.finishAuth((await consent(consentB.searchParams)).searchParams);
    expect(claimsOf(b.provider.tokenSet.access_token)).toMatchObject({ workspace_id: wsB });

    // A refresh keeps the grant's brand rather than picking a new one.
    const refreshed = await fetch(`${t.base}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.base },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: a.provider.tokenSet.refresh_token as string,
        client_id: a.provider.info.client_id as string,
      }),
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    expect(claimsOf((await refreshed.json()).access_token)).toMatchObject({ workspace_id: wsA });
  }, 60_000);
});
