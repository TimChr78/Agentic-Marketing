import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import type { Workspace } from '../../app/session';
import { getWorkspaceTimeZone } from '../../ui/time';
import { type HomeClock, type HomePeriod, homeClock } from './period';

// The bounded Home reads (#447). One load shares `agents.list`, `approvals.list` and the
// workspace already loaded by the session between every block that needs them; nothing here fans
// out per row. Each block keeps its own loading/error state so one failed read never blanks the
// rest of the page.

export type ApprovalsResult = Out<'approvals.list'>;
export type AgentsResult = Out<'agents.list'>;
export type AlertsResult = Out<'alerts.list'>;
export type FailuresResult = Out<'agents.runFailures'>;
export type BroadcastsResult = Out<'broadcasts.list'>;
export type JourneysResult = Out<'artifacts.list'>;
export type ProfilesResult = Out<'profiles.list'>;
export type StatusResult = Out<'system.status'>;
export type PerformanceResult = Out<'analytics.query'>;

/** Completion of the brand scan: the published pointer is the fact, a draft is not. */
export interface BrandScan {
  published: boolean;
  publishedVersion: number | null;
  name: string | null;
  pages: number;
}

export interface PerformanceBlock {
  current: PerformanceResult;
  previous: PerformanceResult | null;
  previousError: string | null;
  period: HomePeriod;
}

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  loadedAt: string | null;
}

interface HomeValues {
  approvals: ApprovalsResult;
  agents: AgentsResult;
  alerts: AlertsResult;
  failures: FailuresResult;
  broadcasts: BroadcastsResult;
  journeys: JourneysResult;
  brand: BrandScan;
  profiles: ProfilesResult;
  status: StatusResult;
  performance: PerformanceBlock;
}

type HomeState = { [K in keyof HomeValues]: Resource<HomeValues[K]> };

export type HomeResourceKey = keyof HomeValues;

const empty = <T>(): Resource<T> => ({ data: undefined, error: null, loading: false, loadedAt: null });

const initialState = (): HomeState => ({
  approvals: empty(),
  agents: empty(),
  alerts: empty(),
  failures: empty(),
  broadcasts: empty(),
  journeys: empty(),
  brand: empty(),
  profiles: empty(),
  status: empty(),
  performance: empty(),
});

export interface HomeDataOptions {
  workspace: Workspace;
  can: (permission: string) => boolean;
  /** Checklist reads are issued only for an eligible role while the checklist is not hidden. */
  checklistActive: boolean;
}

export interface HomeData {
  resources: HomeState;
  clock: HomeClock;
  /** When the most recent load finished, for "Fetched [time]". */
  fetchedAt: string | null;
  /** The newest successful read, for "Last loaded [time]; refresh failed". */
  lastLoadedAt: string | null;
  refreshFailed: boolean;
  refreshing: boolean;
  reload: () => Promise<void>;
  retry: {
    approvals: () => Promise<void>;
    agents: () => Promise<void>;
    alerts: () => Promise<void>;
    failures: () => Promise<void>;
    broadcasts: () => Promise<void>;
    journeys: () => Promise<void>;
    brand: () => Promise<void>;
    profiles: () => Promise<void>;
    status: () => Promise<void>;
    performance: () => Promise<void>;
  };
}

const MEASURES = ['email.sent', 'email.delivered', 'email.clicked', 'email.click_rate'];

export function useHomeData({ workspace, can, checklistActive }: HomeDataOptions): HomeData {
  const zone = workspace.timeZone || getWorkspaceTimeZone();
  const [state, setState] = useState<HomeState>(initialState);
  const [clock, setClock] = useState<HomeClock>(() => homeClock(new Date(), zone));
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const clockRef = useRef(clock);
  const sequences = useRef<Record<HomeResourceKey, number>>({
    approvals: 0,
    agents: 0,
    alerts: 0,
    failures: 0,
    broadcasts: 0,
    journeys: 0,
    brand: 0,
    profiles: 0,
    status: 0,
    performance: 0,
  });
  const startedFor = useRef<string | null>(null);

  const setResource = useCallback(<K extends HomeResourceKey>(key: K, patch: Partial<Resource<HomeValues[K]>>) => {
    setState((current) => ({ ...current, [key]: { ...current[key], ...patch } }) as HomeState);
  }, []);

  const runResource = useCallback(
    async <K extends HomeResourceKey>(key: K, fetcher: () => Promise<HomeValues[K]>) => {
      const run = ++sequences.current[key];
      setResource(key, { loading: true, error: null });
      try {
        const data = await fetcher();
        if (sequences.current[key] !== run) return;
        setResource(key, { data, error: null, loading: false, loadedAt: new Date().toISOString() });
      } catch (e) {
        if (sequences.current[key] !== run) return;
        setResource(key, { error: errText(e), loading: false });
      }
    },
    [setResource],
  );

  const loadApprovals = useCallback(
    () => runResource('approvals', () => api.call('approvals.list', { status: 'pending', limit: 20 })),
    [runResource],
  );
  const loadAgents = useCallback(() => runResource('agents', () => api.call('agents.list', {})), [runResource]);
  const loadAlerts = useCallback(() => runResource('alerts', () => api.call('alerts.list', {})), [runResource]);
  const loadFailures = useCallback(
    (activeClock: HomeClock) =>
      runResource('failures', () =>
        api.call('agents.runFailures', { since: new Date(activeClock.now.getTime() - 7 * 86_400_000).toISOString(), limit: 3 }),
      ),
    [runResource],
  );
  const loadBroadcasts = useCallback(
    () => runResource('broadcasts', () => api.call('broadcasts.list', { statuses: ['scheduled', 'running'], limit: 5 })),
    [runResource],
  );
  const loadJourneys = useCallback(
    () => runResource('journeys', () => api.call('artifacts.list', { type: 'journey', limit: 20 })),
    [runResource],
  );
  const loadStatus = useCallback(() => runResource('status', () => api.call('system.status', {})), [runResource]);
  const loadProfiles = useCallback(() => runResource('profiles', () => api.call('profiles.list', { limit: 1 })), [runResource]);
  const loadBrand = useCallback(
    () =>
      runResource('brand', async () => {
        let cursor: string | undefined;
        let pages = 0;
        // The brand list is one artifact per workspace in practice; page it as the contract asks
        // and stop at the first published pointer instead of reading the rest.
        while (pages < 50) {
          const page = await api.call('artifacts.list', { type: 'brand', limit: 100, ...(cursor ? { cursor } : {}) });
          pages++;
          const published = page.artifacts.find((artifact) => artifact.publishedVersion !== null);
          if (published) {
            return {
              published: true,
              publishedVersion: published.publishedVersion,
              name: published.name,
              pages,
            };
          }
          if (!page.nextCursor) return { published: false, publishedVersion: null, name: null, pages };
          cursor = page.nextCursor;
        }
        throw new Error('The brand list is too long to check in one Home load.');
      }),
    [runResource],
  );
  const loadPerformance = useCallback(
    (activeClock: HomeClock) =>
      runResource('performance', async () => {
        const current = await api.call('analytics.query', {
          measures: MEASURES,
          dimensions: [],
          from: activeClock.period.from,
          to: activeClock.period.to,
          limit: 1,
        });
        // The previous period is optional: a failed comparison removes the delta, never the value.
        try {
          const previous = await api.call('analytics.query', {
            measures: MEASURES,
            dimensions: [],
            from: activeClock.period.previousFrom,
            to: activeClock.period.previousTo,
            limit: 1,
          });
          return { current, previous, previousError: null, period: activeClock.period };
        } catch (e) {
          return { current, previous: null, previousError: errText(e), period: activeClock.period };
        }
      }),
    [runResource],
  );

  const readArtifacts = can('artifacts:read');
  const readProfiles = can('profiles:read');
  const admin = can('workspace:admin');

  const loadAll = useCallback(async () => {
    const next = homeClock(new Date(), zone);
    clockRef.current = next;
    setClock(next);
    const work: Promise<void>[] = [];
    if (readArtifacts) {
      work.push(loadApprovals(), loadAgents(), loadAlerts(), loadFailures(next), loadBroadcasts(), loadJourneys(), loadPerformance(next));
    }
    if (checklistActive) {
      if (readArtifacts) work.push(loadBrand());
      // The e-mail check is admin-only, so a Builder never pays for a status read it cannot use.
      if (readArtifacts && admin) work.push(loadStatus());
      if (readProfiles) work.push(loadProfiles());
    }
    await Promise.all(work);
    setFetchedAt(new Date().toISOString());
  }, [
    zone,
    readArtifacts,
    readProfiles,
    admin,
    checklistActive,
    loadApprovals,
    loadAgents,
    loadAlerts,
    loadFailures,
    loadBroadcasts,
    loadJourneys,
    loadPerformance,
    loadBrand,
    loadStatus,
    loadProfiles,
  ]);

  useEffect(() => {
    if (startedFor.current === workspace.id) return;
    startedFor.current = workspace.id;
    void loadAll();
  }, [workspace.id, loadAll]);

  // Restoring the checklist from the footer starts its reads without reloading every block.
  const previousActive = useRef(checklistActive);
  useEffect(() => {
    if (checklistActive && !previousActive.current) {
      const work: Promise<void>[] = [];
      if (readArtifacts) work.push(loadBrand());
      if (readArtifacts && admin) work.push(loadStatus());
      if (readProfiles) work.push(loadProfiles());
      void Promise.all(work);
    }
    previousActive.current = checklistActive;
  }, [checklistActive, readArtifacts, readProfiles, admin, loadBrand, loadStatus, loadProfiles]);

  const lastLoadedAt = useMemo(() => {
    const times = Object.values(state)
      .map((resource) => resource.loadedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    return times.at(-1) ?? null;
  }, [state]);

  const refreshFailed = useMemo(
    () => Object.values(state).some((resource) => resource.error !== null && resource.data !== undefined),
    [state],
  );

  const refreshing = useMemo(() => Object.values(state).some((resource) => resource.loading), [state]);

  const retry = useMemo(
    () => ({
      approvals: loadApprovals,
      agents: loadAgents,
      alerts: loadAlerts,
      failures: () => loadFailures(clockRef.current),
      broadcasts: loadBroadcasts,
      journeys: loadJourneys,
      brand: loadBrand,
      profiles: loadProfiles,
      status: loadStatus,
      performance: () => loadPerformance(clockRef.current),
    }),
    [
      loadApprovals,
      loadAgents,
      loadAlerts,
      loadFailures,
      loadBroadcasts,
      loadJourneys,
      loadBrand,
      loadProfiles,
      loadStatus,
      loadPerformance,
    ],
  );

  return { resources: state, clock, fetchedAt, lastLoadedAt, refreshFailed, refreshing, reload: loadAll, retry };
}
