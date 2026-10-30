import { Suspense } from 'react';
import { Alert, Button, LoadingBlock, ToastProvider } from '../ui';
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
    <Shell>
      <Suspense fallback={<LoadingBlock lines={6} />}>
        <Routes />
      </Suspense>
    </Shell>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[480px] px-4 pt-[18vh]">{children}</div>;
}
