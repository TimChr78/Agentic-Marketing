import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../ui';
import { AuthShell } from './AuthShell';
import { Link } from './router';
import { ThemeMenu } from './Shell';

/** Sign-in (#34): the only signed-out screen of the real app. The demo is linked from here only. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
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
            else setErr((await r.json().catch(() => ({}))).message ?? `Sign-in failed (${r.status}).`);
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
      </form>
    </AuthShell>
  );
}
