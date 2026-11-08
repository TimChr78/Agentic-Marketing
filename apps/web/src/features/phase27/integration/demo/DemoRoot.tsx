import { useEffect, useMemo, useState } from 'react';
import { getWorkspaceId, setWorkspaceId } from '../../../../app/api';
import { AuthenticatedRoot } from '../../../../app/Root';
import { SessionContext } from '../../../../app/session';
import { ToastProvider } from '../../../../ui';
import { setWorkspaceTimeZone } from '../../../../ui/time';
import { DEMO_TIME_ZONE, DEMO_WORKSPACE_ID } from './fixtures';
import { DEMO_BANNER, DEMO_BANNER_HINT, demoSessionValue } from './session';
import { installDemoTransport } from './transport';

/**
 * The real shell in demo mode (#524): the same Root gate, shell, navigation and pages as
 * production, over the fixture session and read transport. There is no legacy demo app and no
 * second page implementation. The marker is persistent, so every page, dialog and deep link is
 * visibly sample data; the shell keeps its ordinary context line.
 *
 * D replaces the entry point on top of this (main.tsx / the single-file build); pages never learn
 * that they are in demo mode.
 */
export function DemoRoot() {
  const session = useMemo(() => demoSessionValue(), []);
  // Install synchronously during render: child effects run before the parent's, so a page's first
  // read must already see the fixture transport. The cleanup removes it when the demo unmounts.
  const [cleanup] = useState(() => {
    const uninstall = installDemoTransport();
    setWorkspaceTimeZone(DEMO_TIME_ZONE);
    // Keyed caches act in the demo workspace, in memory only: the stored workspace of a signed-in
    // person is left untouched.
    const previous = getWorkspaceId();
    setWorkspaceId(DEMO_WORKSPACE_ID, { persist: false });
    return () => {
      uninstall();
      setWorkspaceId(previous, { persist: false });
    };
  });
  useEffect(() => cleanup, [cleanup]);
  return (
    <ToastProvider>
      <SessionContext.Provider value={session}>
        <DemoBanner />
        <AuthenticatedRoot />
      </SessionContext.Provider>
    </ToastProvider>
  );
}

/** The persistent sample-data marker. Wraps at 390 px without covering primary controls. */
export function DemoBanner() {
  return (
    <div
      role="note"
      aria-label="Demo mode"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-line bg-surface-2 px-4 py-1.5 text-center text-[12px] leading-[18px] text-fg-2"
    >
      <strong className="font-semibold text-fg">{DEMO_BANNER}</strong>
      <span className="text-muted">{DEMO_BANNER_HINT}</span>
    </div>
  );
}
