import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../ui';
import { AuthShell } from './AuthShell';
import { Link } from './router';

// Choosing a new password from the link in the reset e-mail (#191). The token comes from the query
// string; the server sends `Referrer-Policy: no-referrer` for this page, so it never reaches
// another request. An expired, used or malformed token gets a clear error and a way to ask again.

const MIN_PASSWORD = 10;

export function ResetPassword({ token }: { token: string | null }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [expired, setExpired] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const again = (
    <Link to="/forgot-password" className="mt-6 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
      Request a new link <ArrowRight size={14} aria-hidden />
    </Link>
  );

  if (!token)
    return (
      <AuthShell title="Reset password" lead="This page needs the link from the reset e-mail.">
        <Alert tone="bad" title="This link is incomplete">
          Open the link in the e-mail again, or ask for a new one.
        </Alert>
        {again}
      </AuthShell>
    );

  if (done)
    return (
      <AuthShell title="Password changed" lead="Every other session of your account has been signed out.">
        <Alert tone="good" title="You can sign in now">
          Use your new password the next time you sign in.
        </Alert>
        <Link to="/" className="mt-6 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          Go to sign in <ArrowRight size={14} aria-hidden />
        </Link>
      </AuthShell>
    );

  return (
    <AuthShell title="Choose a new password" lead={`At least ${MIN_PASSWORD} characters. You will sign in with it from now on.`}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr('');
          if (password.length < MIN_PASSWORD) {
            setErr(`Use at least ${MIN_PASSWORD} characters.`);
            return;
          }
          if (password !== confirm) {
            setErr('The two passwords do not match.');
            return;
          }
          setBusy(true);
          setExpired(false);
          try {
            const r = await fetch('/api/auth/reset-password', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token, newPassword: password }),
            });
            const body = (await r.json().catch(() => ({}))) as { message?: string; code?: string };
            if (r.ok) setDone(true);
            else if (body.code === 'INVALID_TOKEN') {
              setExpired(true);
              setErr('This reset link has expired or was already used. Ask for a new one.');
            } else setErr(body.message ?? `The password could not be changed (${r.status}).`);
          } catch {
            setErr('The server did not answer. Check that it is running and try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="New password" id="reset-password" hint={`At least ${MIN_PASSWORD} characters.`}>
          <Input
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Confirm new password" id="reset-confirm">
          <Input
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {err && <Alert tone="bad">{err}</Alert>}
        {expired && again}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Set new password
        </Button>
      </form>
      <p className="mt-4 text-[13px] text-muted">
        Signed in with single sign-on only? A password is not needed for your account; ask your admin if you are unsure.
      </p>
      <div className="mt-8 border-t border-line pt-5 text-[13px] text-muted">
        <p>Did not ask for this?</p>
        <Link to="/" className="mt-2 inline-flex items-center gap-1 font-medium text-accent hover:underline">
          Back to sign in <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
    </AuthShell>
  );
}
