import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1248: an address on an SSO-enforced domain cannot sign in with a password (`ssoGuard` refuses
// it), so the sign-in page must offer "Sign in with SSO" and show the server's own reason instead
// of telling the person to check a password that can never work.

if (!window.matchMedia)
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

// theme.ts reads matchMedia at module load, so it is imported after the polyfill.
const { SignIn } = await import('../src/app/SignIn');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sign in with single sign-on (#1248)', () => {
  it('offers "Sign in with SSO" and starts SSO for the typed address', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/sign-in/sso') return json({ url: 'https://idp.acme.test/authorize?state=1', redirect: true });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<SignIn onDone={onDone} />);

    const sso = screen.getByRole('button', { name: 'Sign in with SSO' });
    await userEvent.type(screen.getByLabelText('E-mail'), 'jo@acme.com');
    await userEvent.click(sso);

    const call = fetchMock.mock.calls.find(([url]) => url === '/api/auth/sign-in/sso') as [string, { body: string }] | undefined;
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toEqual({ email: 'jo@acme.com', callbackURL: '/' });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows the server’s reason when password sign-in is refused for an SSO-enforced domain', async () => {
    const message = 'acme.com signs in with single sign-on. Use "Sign in with SSO".';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/sign-in/email') return json({ code: 'FORBIDDEN', message }, 403);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignIn onDone={() => {}} />);

    await userEvent.type(screen.getByLabelText('E-mail'), 'jo@acme.com');
    await userEvent.type(screen.getByLabelText('Password'), 'any-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText('Couldn’t sign in. Check your e-mail and password, then try again.')).toBeNull();
  });
});
