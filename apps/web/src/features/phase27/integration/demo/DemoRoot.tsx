import { X } from 'lucide-react';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { CapabilitiesProvider, DEMO_CAPABILITIES } from '../../../../app/capabilities';
import { Routes } from '../../../../app/routes';
import { Shell } from '../../../../app/Shell';
import { SessionContext } from '../../../../app/session';
import { AutonomyProvider } from '../../../../features/agents/AutonomyProvider';
import { Button, LoadingBlock, ToastProvider } from '../../../../ui';
import { demoLiveRetired, enterDemo, LIVE_RETIRED_NOTICE } from '../../demo/entry';
import { ensureDemoRuntime, teardownDemoRuntime } from '../../demo/runtime';
import { DEMO_BANNER, DEMO_BANNER_HINT, demoSessionValue } from './session';

/**
 * The real shell in demo mode (#524, #530): the same authenticated shell, navigation and page
 * routes as production over the fixture session and read transport. There is no legacy demo app and
 * no second page implementation. The shell is composed here rather than through Root so the demo
 * chunk and the real Root chunk stay separate in the bundle. The marker is persistent, so every
 * page, dialog and deep link is visibly sample data; the shell keeps its ordinary context line.
 *
 * The entry normalises `/demo`, the legacy hashes and the retired live-site walkthrough before the
 * shell mounts. Every navigation afterwards is confined to `/demo`, so reload and back/forward stay
 * on fixtures, while a typed real URL or the sign-in exit starts a real session.
 */
export function DemoRoot() {
  const session = useMemo(() => demoSessionValue(), []);
  const [liveRetired, setLiveRetired] = useState(() => {
    const entry = enterDemo();
    // Install synchronously during render: child effects run before the parent's, so a page's first
    // read must already see the fixture transport.
    ensureDemoRuntime();
    return entry.liveRetired || demoLiveRetired();
  });
  // The setup runs again after StrictMode's replay cleanup, so the runtime is re-installed there.
  useEffect(() => {
    ensureDemoRuntime();
    return teardownDemoRuntime;
  }, []);

  return (
    <ToastProvider>
      <SessionContext.Provider value={session}>
        <CapabilitiesProvider value={DEMO_CAPABILITIES}>
          <DemoBanner />
          {liveRetired && <LiveRetiredNotice onClose={() => setLiveRetired(false)} />}
          <AutonomyProvider>
            <Suspense fallback={<LoadingBlock lines={6} />}>
              <Shell>
                <Suspense fallback={<LoadingBlock lines={6} />}>
                  <Routes />
                </Suspense>
              </Shell>
            </Suspense>
          </AutonomyProvider>
        </CapabilitiesProvider>
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
      {import.meta.env.MODE !== 'single' && (
        <a href="/" className="font-medium text-accent hover:underline">
          Sign in to your workspace
        </a>
      )}
    </div>
  );
}

/**
 * The short, non-executing explanation kept where the legacy live-site walkthrough was. It never
 * offers a control that would run anything; the real destinations linked from it are the product.
 */
export function LiveRetiredNotice({ onClose }: { onClose: () => void }) {
  return (
    <div role="status" className="border-b border-line bg-accent-soft px-4 py-2.5 text-[13px] leading-5 text-fg-2">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-start gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1">
          <strong className="font-semibold text-fg">The live-site walkthrough has been retired.</strong> {LIVE_RETIRED_NOTICE}
        </p>
        <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onClose} aria-label="Dismiss the live-site notice">
          Dismiss
        </Button>
      </div>
    </div>
  );
}
