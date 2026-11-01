import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgotPassword } from '../src/app/ForgotPassword';
import { ResetPassword } from '../src/app/ResetPassword';

// The signed-out password reset screens (#191): the neutral answer, the accessible fields, the
// mismatch and expiry messages, and the token that reaches the API.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('forgot password', () => {
  it('asks for the e-mail address and shows the same neutral answer', async () => {
    const fetchMock = vi.fn(async () => json({ status: true, message: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ForgotPassword />);

    const email = screen.getByLabelText('E-mail');
    expect(email.getAttribute('autocomplete')).toBe('email');
    await userEvent.type(email, 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a link' }));

    expect(await screen.findByText(/If an account exists for that address/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/forgot-password', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toEqual({ email: 'ada@example.com' });
  });

  it('explains a rate limit instead of claiming the address is wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ status: false, code: 'RATE_LIMITED' }, 429)),
    );
    render(<ForgotPassword />);
    await userEvent.type(screen.getByLabelText('E-mail'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a link' }));
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
  });
});

describe('reset password', () => {
  it('sets a new password with the token from the link', async () => {
    const fetchMock = vi.fn(async () => json({ status: true, message: 'changed' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ResetPassword token="tok-123" />);

    const password = screen.getByLabelText('New password');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(password.getAttribute('type')).toBe('password');
    await userEvent.type(password, 'a-brand-new-staple-42');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-staple-42');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Password changed')).toBeTruthy();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toEqual({ token: 'tok-123', newPassword: 'a-brand-new-staple-42' });
  });

  it('refuses mismatched or too short passwords without calling the API', async () => {
    const fetchMock = vi.fn(async () => json({ status: true }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ResetPassword token="tok-123" />);

    await userEvent.type(screen.getByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/Use at least 10 characters/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a clear error and a way to ask again for an expired or used link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ status: false, code: 'INVALID_TOKEN' }, 400)),
    );
    render(<ResetPassword token="tok-123" />);
    await userEvent.type(screen.getByLabelText('New password'), 'a-brand-new-staple-42');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-staple-42');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Request a new link/ }).getAttribute('href')).toBe('/forgot-password');
  });

  it('explains a link without a token', () => {
    render(<ResetPassword token={null} />);
    expect(screen.getByText('This link is incomplete')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Request a new link/ }).getAttribute('href')).toBe('/forgot-password');
  });
});
