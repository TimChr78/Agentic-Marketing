import type { SessionValue } from '../../../../app/session';
import {
  DEMO_MEMBERSHIPS,
  DEMO_NOW,
  DEMO_PENDING_APPROVALS,
  DEMO_PERMISSIONS,
  DEMO_TIME_ZONE,
  DEMO_USER,
  DEMO_WORKSPACE,
} from './fixtures';

/** The fixed clock the demo fixtures were projected at (the e2e seed's `FIXED_NOW`). */
export function demoNow(): Date {
  return new Date(DEMO_NOW);
}

/**
 * The demo session (#524): a ready, fixture-backed session for the real shell. It never calls
 * `/api/auth/get-session`, never reads a stored workspace id, and never polls the API, so a demo
 * visitor cannot act in their real workspace and a signed-in person does not inherit their session.
 * The role is the seeded owner; permission checks are the ordinary ones, not a demo bypass.
 */
export function demoSessionValue(): SessionValue {
  const permissions = new Set<string>(DEMO_PERMISSIONS);
  return {
    status: 'ready',
    user: DEMO_USER,
    workspace: DEMO_WORKSPACE,
    memberships: DEMO_MEMBERSHIPS,
    can: (permission: string) => permissions.has(permission),
    refresh: async () => {},
    switchWorkspace: async () => {},
    // The demo's only exit is the normal sign-in page; no demo identity survives it.
    signOut: async () => {
      if (typeof window !== 'undefined') window.location.assign('/');
    },
    signOutError: null,
    pending: DEMO_PENDING_APPROVALS.length,
    refreshPending: () => {},
  };
}

/** Copy the persistent demo marker uses on every page, including dialogs and deep links. */
export const DEMO_BANNER = 'Simulated demo · sample data';
export const DEMO_BANNER_HINT = 'Changes are unavailable. Dates come from a fixed sample.';
export const DEMO_TIME_ZONE_LABEL = DEMO_TIME_ZONE;
