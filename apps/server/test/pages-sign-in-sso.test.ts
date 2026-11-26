import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { invitePage, loginPage } from '../src/http/pages';

// #1248: the server-rendered OAuth sign-in page and the invitation page must offer
// "Sign in with SSO" too; without it, a person whose domain enforces SSO cannot sign in or accept
// an invitation. The OAuth page returns to the signed authorize request; the invite page keeps its
// token across the redirect, because the fragment is not sent to the identity provider.

function scriptOf(html: string): string {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi)].map((m) => m[1]).join('\n');
}

interface Call {
  url: string;
  body: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function renderLogin(query: string, ssoAnswer: () => Response = () => json({})) {
  const page = loginPage('test-nonce');
  const window = new Window({ url: `https://am.example.com/login${query}` });
  window.document.write(page);
  const calls: Call[] = [];
  Object.assign(window, {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return url === '/api/auth/sign-in/sso' ? ssoAnswer() : json({});
    },
  });
  const bridge = `const f = document.getElementById('f'), email = document.getElementById('email'),
    password = document.getElementById('password'), err = document.getElementById('err'),
    sso = document.getElementById('sso');`;
  window.eval(`${bridge}\n${scriptOf(page)}`);
  return { window, document: window.document, calls };
}

async function renderInvite(path: string, signedIn: boolean, storage: Record<string, string> = {}) {
  const page = invitePage('test-nonce');
  const window = new Window({ url: `https://am.example.com${path}` });
  window.document.write(page);
  for (const [key, value] of Object.entries(storage)) window.sessionStorage.setItem(key, value);
  const calls: Call[] = [];
  Object.assign(window, {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      if (url === '/api/auth/get-session') return json(signedIn ? { user: { id: 'usr_1' } } : { user: null });
      if (url === '/api/invitations/accept') return json({ role: 'marketer' });
      return json({});
    },
  });
  const bridge = `const f = document.getElementById('f'), nameRow = document.getElementById('nameRow'),
    name = document.getElementById('name'), email = document.getElementById('email'),
    password = document.getElementById('password'), err = document.getElementById('err'),
    go = document.getElementById('go'), mode = document.getElementById('mode'),
    done = document.getElementById('done'), sso = document.getElementById('sso');`;
  window.eval(`${bridge}\n${scriptOf(page)}`);
  return { window, document: window.document, calls };
}

describe('server sign-in pages offer single sign-on (#1248)', () => {
  it('the OAuth page posts the e-mail and returns to the signed authorize request', async () => {
    const { document, calls } = await renderLogin('?client_id=abc&sig=s');
    const button = document.getElementById('sso') as unknown as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toBe('Sign in with SSO');

    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    button.click();

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sign-in/sso')).toBe(true));
    const call = calls.find((c) => c.url === '/api/auth/sign-in/sso')!;
    expect(JSON.parse(call.body)).toEqual({ email: 'jo@acme.com', callbackURL: '/api/auth/oauth2/authorize?client_id=abc&sig=s' });
  });

  it('the OAuth page falls back to the app root when there is no authorize request', async () => {
    const { document, calls } = await renderLogin('');
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    (document.getElementById('sso') as unknown as HTMLButtonElement).click();

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sign-in/sso')).toBe(true));
    const call = calls.find((c) => c.url === '/api/auth/sign-in/sso')!;
    expect(JSON.parse(call.body)).toEqual({ email: 'jo@acme.com', callbackURL: '/' });
  });

  it('resumes the verified authorize request without the satisfied login prompt', async () => {
    const query = '?client_id=abc&prompt=login%20consent&state=st-1&code_challenge=ch-1&code_challenge_method=S256&sig=s';
    const { document, calls } = await renderLogin(query);
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    (document.getElementById('sso') as unknown as HTMLButtonElement).click();

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sign-in/sso')).toBe(true));
    const call = calls.find((c) => c.url === '/api/auth/sign-in/sso')!;
    // state and PKCE survive, the other prompt survives, and login is gone.
    expect(JSON.parse(call.body)).toEqual({
      email: 'jo@acme.com',
      callbackURL:
        '/api/auth/oauth2/authorize?client_id=abc&prompt=consent&state=st-1&code_challenge=ch-1&code_challenge_method=S256&sig=s',
    });
  });

  it('drops a prompt that only asks for login', async () => {
    const { document, calls } = await renderLogin('?client_id=abc&prompt=login&sig=s');
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    (document.getElementById('sso') as unknown as HTMLButtonElement).click();

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sign-in/sso')).toBe(true));
    const call = calls.find((c) => c.url === '/api/auth/sign-in/sso')!;
    expect(JSON.parse(call.body)).toEqual({ email: 'jo@acme.com', callbackURL: '/api/auth/oauth2/authorize?client_id=abc&sig=s' });
  });

  it('shows plain language instead of a raw provider error (#1277 re-review)', async () => {
    const { document } = await renderLogin('?client_id=abc&sig=s', () => json({ message: 'No provider found for the issuer' }, 404));
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    (document.getElementById('sso') as unknown as HTMLButtonElement).click();
    const err = document.getElementById('err')!;
    await vi.waitFor(() => expect(err.textContent).toContain('No single sign-on is set up for that address'));
    expect(err.textContent).not.toContain('issuer');
  });

  it('keeps the enforced-domain refusal verbatim (#1277 re-review)', async () => {
    const refusal = 'acme.com signs in with single sign-on. Use “Sign in with SSO”.';
    const { document } = await renderLogin('', () => json({ message: refusal }, 403));
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    (document.getElementById('sso') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById('err')!.textContent).toBe(refusal));
  });

  it('starts SSO when the forwarded query holds a malformed escape (#1277 re-review)', async () => {
    const { document, calls } = await renderLogin('?client_id=abc&x%=1&prompt=login&sig=s');
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    (document.getElementById('sso') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sign-in/sso')).toBe(true));
    const call = calls.find((c) => c.url === '/api/auth/sign-in/sso')!;
    expect(JSON.parse(call.body).callbackURL).toBe('/api/auth/oauth2/authorize?client_id=abc&x%=1&sig=s');
  });

  it('the invitation page keeps the token in the tab and returns with a single-use marker', async () => {
    const { window, document, calls } = await renderInvite('/invite#tok-123', false);
    const button = document.getElementById('sso') as unknown as HTMLButtonElement;
    expect(button).toBeTruthy();
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    button.click();

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sign-in/sso')).toBe(true));
    const call = calls.find((c) => c.url === '/api/auth/sign-in/sso')!;
    const body = JSON.parse(call.body) as { email: string; callbackURL: string };
    expect(body.email).toBe('jo@acme.com');
    // The token is not in the callback URL Better Auth stores; only a marker is.
    expect(body.callbackURL.startsWith('/invite?return=')).toBe(true);
    expect(body.callbackURL).not.toContain('tok-123');
    expect(window.sessionStorage.getItem('am-invite')).toBe('tok-123');
    const marker = new URL(body.callbackURL, 'https://am.example.com').searchParams.get('return');
    expect(marker).toBeTruthy();
    expect(window.sessionStorage.getItem('am-invite-return')).toBe(marker);
  });

  it('the invitation page joins with the saved token once SSO has signed the person in', async () => {
    const { window, document, calls } = await renderInvite('/invite#tok-123', true);

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/invitations/accept')).toBe(true));
    const call = calls.find((c) => c.url === '/api/invitations/accept')!;
    expect(JSON.parse(call.body)).toEqual({ token: 'tok-123' });
    expect((document.getElementById('done') as unknown as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('done') as unknown as HTMLElement).textContent).toContain('marketer');
    expect(window.sessionStorage.getItem('am-invite')).toBeNull();
  });

  it('joins on a return that carries only the stored invite token', async () => {
    const { window, document, calls } = await renderInvite('/invite?return=m1', true, {
      'am-invite': 'tok-123',
      'am-invite-return': 'm1',
    });

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/invitations/accept')).toBe(true));
    const call = calls.find((c) => c.url === '/api/invitations/accept')!;
    expect(JSON.parse(call.body)).toEqual({ token: 'tok-123' });
    expect((document.getElementById('done') as unknown as HTMLElement).hidden).toBe(false);
    expect(window.sessionStorage.getItem('am-invite')).toBeNull();
    expect(window.sessionStorage.getItem('am-invite-return')).toBeNull();
  });
});
