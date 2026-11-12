import { lazy, Suspense, useEffect } from 'react';
import { AutonomyProvider } from '../features/agents/AutonomyProvider';
import { Alert, AuthSkeleton, Button, LoadingBlock, ToastProvider, useToast } from '../ui';
import { RouteErrorBoundary } from './ErrorBoundary';
import { ForgotPassword } from './ForgotPassword';
import { ResetPassword } from './ResetPassword';
import { useLocation } from './router';
import { SignIn } from './SignIn';
import { SessionProvider, useSession } from './session';

// The signed-in shell (and its command palette, New menu and copilot) is only needed after
// authentication, so the sign-in screen stays light and the shell loads as one chunk.
const Shell = lazy(async () => ({ default: (await import('./Shell')).Shell }));
// The route table (and with it every page's dynamic import) is not needed to render a signed-out
// screen, so it joins the signed-in closure after the session resolves.
const Routes = lazy(async () => ({ default: (await import('./routes')).Routes }));

export function Root() {
  return (
    <ToastProvider>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ToastProvider>
  );
}

function Gate() {
  const { status, refresh, signOut, user, signOutError } = useSession();
  const toast = useToast();
  const { path, search } = useLocation();
  // A refused or unreachable sign-out keeps the session and says so (#614).
  useEffect(() => {
    if (signOutError) toast.error(signOutError);
  }, [signOutError, toast]);
  // Signed-out screens that stand on their own (#191). They work whether or not a session exists,
  // so a reset link opened in a signed-in browser still changes the password.
  if (path === '/forgot-password') return <ForgotPassword />;
  if (path === '/reset-password') return <ResetPassword token={search.get('token')} />;
  if (status === 'loading')
    return (
      <main className="min-h-screen bg-bg">
        <AuthSkeleton label="Loading your workspace" />
      </main>
    );
  if (status === 'signed-out') return <SignIn onDone={() => void refresh()} />;
  if (status === 'offline')
    return (
      <Centered>
        <Alert tone="bad" title="Can't reach the server" onRetry={() => void refresh()}>
          The API did not answer. Check that the server is running and that this page is served from it.
        </Alert>
      </Centered>
    );
  if (status === 'no-workspace')
    return (
      <Centered>
        <Alert tone="warn" title="You're not in a workspace yet">
          {user?.email} is signed in but is not a member of any workspace. Ask an admin to invite you, then open the link in the invitation.
        </Alert>
        <Button className="mt-4" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Centered>
    );
  return (
    <AutonomyProvider>
      <Suspense fallback={<LoadingBlock lines={6} label="Loading the shell" />}>
        <Shell>
          {/* Clears a failed route on navigation without remounting the lazy route tree (#791). */}
          <RouteErrorBoundary resetKey={path}>
            <Suspense fallback={<LoadingBlock lines={6} label="Loading this page" />}>
              <Routes />
            </Suspense>
          </RouteErrorBoundary>
        </Shell>
      </Suspense>
    </AutonomyProvider>
  );
}

/** The real shell gate; the demo entry renders the same gate over a fixture session. */
export { Gate as AuthenticatedRoot };

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[480px] px-4 pt-[18vh]">{children}</div>;
}
