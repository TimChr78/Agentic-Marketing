import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../ui';
import { ThemeMenu } from './Shell';

/** Sign-in (#34): the only signed-out screen of the real app. The demo is linked from here only. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <div className="flex justify-end p-3">
        <ThemeMenu />
      </div>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="w-full max-w-[380px]">
          <div className="mb-6 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-md bg-fg text-[13px] font-semibold text-bg" aria-hidden>
              A
            </span>
            <span className="text-[15px] font-semibold">Agentic Marketing</span>
          </div>
          <h1 className="text-[20px] leading-7 font-semibold">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted">Use the e-mail address your workspace admin invited.</p>
          <form
            className="mt-6 space-y-4"
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
            <Field label="E-mail">
              <Input id="signin-email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus autoFocus />
            </Field>
            <Field label="Password">
              <Input id="signin-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {err && <Alert tone="bad">{err}</Alert>}
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Sign in
            </Button>
          </form>
          <div className="mt-8 border-t border-line pt-5 text-[13px] text-muted">
            <p>New here? See how agents draft and people approve, with sample data and no sign-in.</p>
            <a href="/demo" className="mt-2 inline-flex items-center gap-1 font-medium text-accent hover:underline">
              Try the demo <ArrowRight size={14} aria-hidden />
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
