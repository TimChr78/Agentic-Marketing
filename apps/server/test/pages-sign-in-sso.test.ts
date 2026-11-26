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

async function renderLogin(query: string) {
  const page = loginPage('test-nonce');
  const window = new Window({ url: `https://am.example.com/login${query}` });
  window.document.write(page);
  const calls: Call[] = [];
  Object.assign(window, {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return json({});
    },
  });
  const bridge = `const f = document.getElementById('f'), email = document.getElementById('email'),
    password = document.getElementById('password'), err = document.getElementById('err'),
    sso = document.getElementById('sso');`;
  window.eval(`${bridge}\n${scriptOf(page)}`);
  return { window, document: window.document, calls };
}

async function renderInvite(hash: string, signedIn: boolean) {
  const page = invitePage('test-nonce');
  const window = new Window({ url: `https://am.example.com/invite${hash}` });
  window.document.write(page);
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

  it('the invitation page keeps the token across SSO and joins on return', async () => {
    const { window, document, calls } = await renderInvite('#tok-123', false);
    const button = document.getElementById('sso') as unknown as HTMLButtonElement;
    expect(button).toBeTruthy();
    (document.getElementById('email') as unknown as HTMLInputElement).value = 'jo@acme.com';
    button.click();

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/sign-in/sso')).toBe(true));
    const call = calls.find((c) => c.url === '/api/auth/sign-in/sso')!;
    expect(JSON.parse(call.body)).toEqual({ email: 'jo@acme.com', callbackURL: '/invite#tok-123' });
    expect(window.sessionStorage.getItem('am-invite')).toBe('tok-123');
  });

  it('the invitation page joins with the saved token once SSO has signed the person in', async () => {
    const { window, document, calls } = await renderInvite('#tok-123', true);

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/invitations/accept')).toBe(true));
    const call = calls.find((c) => c.url === '/api/invitations/accept')!;
    expect(JSON.parse(call.body)).toEqual({ token: 'tok-123' });
    expect((document.getElementById('done') as unknown as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('done') as unknown as HTMLElement).textContent).toContain('marketer');
    expect(window.sessionStorage.getItem('am-invite')).toBeNull();
  });
});
