import { getWorkspaceId, setWorkspaceId } from '../../../app/api';
import { setRouterBasePath } from '../../../app/router';
import { setWorkspaceTimeZone } from '../../../ui/time';
import { DEMO_TIME_ZONE, DEMO_WORKSPACE_ID } from '../integration/demo/fixtures';
import { installDemoStreamTransport, installDemoTransport } from '../integration/demo/transport';
import { DEMO_BASE_PATH, installDemoHistory } from './entry';

// One replay-safe runtime for the demo page (#530). The transport, history and workspace scope are
// installed before any child effect can read, and a StrictMode effect replay must be able to
// uninstall and install again. The functions are idempotent: repeated renders and repeated effect
// setups share one installation, and only the release that empties it uninstalls.

let runtime: (() => void) | null = null;
let teardownPending = false;

const scheduleMicrotask = (fn: () => void) => {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else void Promise.resolve().then(fn);
};

function install(): () => void {
  const uninstallTransport = installDemoTransport();
  const uninstallStream = installDemoStreamTransport();
  const uninstallHistory = installDemoHistory();
  setRouterBasePath(import.meta.env.MODE === 'single' ? '' : DEMO_BASE_PATH);
  setWorkspaceTimeZone(DEMO_TIME_ZONE);
  const previous = getWorkspaceId();
  // Keyed caches act in the demo workspace, in memory only: the stored workspace of a signed-in
  // person is left untouched.
  setWorkspaceId(DEMO_WORKSPACE_ID, { persist: false });
  return () => {
    uninstallTransport();
    uninstallStream();
    uninstallHistory();
    setWorkspaceId(previous, { persist: false });
    setRouterBasePath('');
  };
}

/** Installs the demo runtime once. Safe to call from render and from every effect setup. */
export function ensureDemoRuntime(): void {
  // A cleanup that is about to run from StrictMode's replay is cancelled by the replay's setup;
  // leaving the runtime installed in between means a child effect never reads without it.
  teardownPending = false;
  if (!runtime) runtime = install();
}

/**
 * Removes the demo runtime after the current task. Safe to call from every effect cleanup: the
 * StrictMode replay's setup calls `ensureDemoRuntime` before the microtask runs and cancels it, so
 * install and cleanup are replay-safe without a gap for child effects.
 */
export function teardownDemoRuntime(): void {
  if (teardownPending) return;
  teardownPending = true;
  scheduleMicrotask(() => {
    if (!teardownPending) return;
    teardownPending = false;
    const uninstall = runtime;
    runtime = null;
    uninstall?.();
  });
}
