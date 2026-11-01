import { Suspense } from 'react';
import { AutonomyProvider } from '../features/agents/AutonomyProvider';
import { Alert, Button, LoadingBlock, ToastProvider } from '../ui';
import { ForgotPassword } from './ForgotPassword';
import { ResetPassword } from './ResetPassword';
import { useLocation } from './router';
import { Routes } from './routes';
import { Shell } from './Shell';
import { SignIn } from './SignIn';
import { SessionProvider, useSession } from './session';

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
  const { status, refresh, signOut, user } = useSession();
  const { path, search } = useLocation();
  // Signed-out screens that stand on their own (#191). They work whether or not a session exists,
  // so a reset link opened in a signed-in browser still changes the password.
  if (path === '/forgot-password') return <ForgotPassword />;
  if (path === '/reset-password') return <ResetPassword token={search.get('token')} />;
  if (status === 'loading')
    return (
      <div className="mx-auto max-w-[480px] pt-[20vh]">
        <LoadingBlock lines={3} label="Loading your workspace" />
      </div>
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
      <Shell>
        <Suspense fallback={<LoadingBlock lines={6} />}>
          <Routes />
        </Suspense>
      </Shell>
    </AutonomyProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[480px] px-4 pt-[18vh]">{children}</div>;
}
