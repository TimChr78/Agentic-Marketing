import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../ui';
import { AuthShell } from './AuthShell';
import { Link } from './router';

// Asking for a reset link (#191). The answer is deliberately the same whether or not the address
// exists: "If an account exists, we sent a link". Single sign-on people get no mail; the page
// points them at SSO without saying whether the address has an account.

const NEUTRAL = 'If an account exists for that address, we sent a link to reset the password. It works once and expires in 45 minutes.';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (sent)
    return (
      <AuthShell title="Check your e-mail" lead="The link takes you to a page where you choose a new password.">
        <Alert tone="good" title="Request received">
          {NEUTRAL}
        </Alert>
        <p className="mt-4 text-[13px] text-muted">
          Signed in with single sign-on instead? Use “Sign in with SSO” on the sign-in page; a password reset is not needed there.
        </p>
        <Link to="/" className="mt-6 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          Back to sign in <ArrowRight size={14} aria-hidden />
        </Link>
      </AuthShell>
    );

  return (
    <AuthShell title="Forgot password" lead="Enter the e-mail address you sign in with and we will send a link to choose a new password.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            const r = await fetch('/api/auth/forgot-password', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email }),
            });
            if (r.ok) setSent(true);
            else if (r.status === 429) setErr('Too many attempts. Wait a few minutes and try again.');
            else setErr((await r.json().catch(() => ({}))).message ?? `The request failed (${r.status}).`);
          } catch {
            setErr('The server did not answer. Check that it is running and try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="E-mail" id="forgot-email">
          <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        {err && <Alert tone="bad">{err}</Alert>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Send me a link
        </Button>
      </form>
      <div className="mt-8 border-t border-line pt-5 text-[13px] text-muted">
        <p>Remembered it?</p>
        <Link to="/" className="mt-2 inline-flex items-center gap-1 font-medium text-accent hover:underline">
          Back to sign in <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
    </AuthShell>
  );
}
