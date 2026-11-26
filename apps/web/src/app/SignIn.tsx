import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../ui';
import { AuthShell } from './AuthShell';
import { Link } from './router';
import { ThemeMenu } from './ThemeMenu';

/** Sign-in (#34): the only signed-out screen of the real app. The demo is linked from here only. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);

  // The password endpoint refuses an enforced domain with the server's own message; show that
  // explanation instead of claiming the password was wrong (#1248).
  const serverReason = async (r: Response, fallback: string) => {
    const body = await r.json().catch(() => null);
    return typeof body?.message === 'string' && body.message ? body.message : fallback;
  };

  const startSso = async () => {
    setErr('');
    const address = email.trim();
    if (!address) {
      setErr('Enter your e-mail address, then choose “Sign in with SSO”.');
      return;
    }
    setSsoBusy(true);
    try {
      const r = await fetch('/api/auth/sign-in/sso', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, callbackURL: '/' }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok && typeof body?.url === 'string') {
        window.location.href = body.url;
        return;
      }
      // Keep the enforced-domain refusal, which names the method that works. Other provider
      // errors ("No provider found for the issuer") are not actionable verbatim (#1277 review).
      const message = typeof body?.message === 'string' ? body.message : undefined;
      if (message && /signs in with single sign-on/i.test(message)) setErr(message);
      else if (r.status === 404)
        setErr(
          'No single sign-on is set up for that address. Use your password, or ask your workspace admin to connect your company’s identity provider.',
        );
      else setErr('Couldn’t start single sign-on. Check the address and try again, or ask your workspace admin to set it up.');
    } catch {
      setErr('The server did not answer. Check that it is running and try again.');
    } finally {
      setSsoBusy(false);
    }
  };
  return (
    <AuthShell
      title="Sign in"
      lead="Use the e-mail address your workspace admin invited."
      actions={<ThemeMenu />}
      footer={
        <>
          <p>New here? See how agents draft and people approve, with sample data and no sign-in.</p>
          <a href="/demo" className="mt-2 inline-flex items-center gap-1 font-medium text-accent hover:underline">
            Try the demo <ArrowRight size={14} aria-hidden />
          </a>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            const r = await fetch('/api/auth/sign-in/email', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email, password }),
            });
            if (r.ok) onDone();
            else setErr(await serverReason(r, 'Couldn’t sign in. Check your e-mail and password, then try again.'));
          } catch {
            setErr('The server did not answer. Check that it is running and try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="E-mail" id="signin-email">
          <Input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-autofocus
            autoFocus
          />
        </Field>
        <Field label="Password" id="signin-password">
          <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-[12px] font-medium text-accent hover:underline">
            Forgot password?
          </Link>
        </div>
        {err && <Alert tone="bad">{err}</Alert>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
        <div className="flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-line" />
          <span className="text-[12px] text-muted">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <Button type="button" variant="secondary" className="w-full" loading={ssoBusy} onClick={() => void startSso()}>
          Sign in with SSO
        </Button>
        <p className="text-center text-[12px] text-muted">Use your company e-mail address; your identity provider asks for the password.</p>
      </form>
    </AuthShell>
  );
}
