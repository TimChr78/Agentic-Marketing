import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errText, type Out } from '../../../app/api';
import { useApi, useKeyedApi } from '../../../app/useApi';
import { useFocusRecheck } from '../../../app/useFocusRecheck';
import { forgetArtifact, getArtifact, onArtifactsChanged } from '../../artifactCache';
import {
  type Channel,
  type CheckRow,
  channelOfTemplate,
  consentCheck,
  domainCheck,
  providerCheck,
  type Stream,
  streamOfBasis,
  templateCheck,
} from './model';

type Got = Out<'artifacts.get'>;
export type ComposerEstimate = Out<'broadcasts.preview'>;

/** The fields that make a re-read news: a moved pointer, a new name, or new content. */
const sameArtifact = (a: Got | null, b: Got) =>
  a?.id === b.id &&
  a.name === b.name &&
  a.publishedVersion === b.publishedVersion &&
  a.latestVersion === b.latestVersion &&
  a.version.contentHash === b.version.contentHash;

/**
 * The template artifact through the shared cache, with its own loading/error so the checklist can
 * offer a local retry.
 *
 * It re-reads whenever this artifact changes (#582): the cache's invalidation signal names the
 * changed artifact, so an unrelated write never flips these rows to "Checking" (#768). `refreshKey`
 * is the explicit "Refresh checks" read. A forced read drops this one entry first, so a refresh
 * never answers from a cached pointer. Each result is tagged with the id it belongs to, so a
 * template switch never exposes the previous template while the new one loads (0.14.6 review).
 *
 * A publish by another tab, person or agent emits no in-tab signal, so a focus return forces the
 * same read — silently: an unchanged pointer updates nothing, and a moved one re-runs the evidence
 * through the keyed exact-version read (#767).
 */
export function useSharedArtifact(id: string | undefined | null, refreshKey = 0) {
  const [loaded, setLoaded] = useState<{ id: string; artifact: Got | null; error: string | null } | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [attempt, setAttempt] = useState(0);

  // Every create, save, publish or delete tells the cache to drop what it knew. Only the artifact
  // this hook reads is a reason to re-read.
  useEffect(() => {
    if (!id) return;
    return onArtifactsChanged((changed) => {
      if (changed && changed !== id) return;
      setAttempt((n) => n + 1);
    });
  }, [id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` and `refreshKey` are explicit re-read triggers, not read by the effect body
  useEffect(() => {
    if (!id) {
      setLoaded(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    forgetArtifact(id);
    getArtifact(id)
      .then((a) => {
        if (live) {
          setLoaded({ id, artifact: a, error: null });
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setLoaded({ id, artifact: null, error: e?.message ?? 'Not found' });
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [id, attempt, refreshKey]);

  const recheck = useCallback(async () => {
    if (!id) return;
    forgetArtifact(id);
    try {
      const artifact = await getArtifact(id);
      setLoaded((prev) => (prev?.id === id && sameArtifact(prev.artifact, artifact) ? prev : { id, artifact, error: null }));
    } catch (e) {
      setLoaded({ id, artifact: null, error: e instanceof Error ? e.message : 'Not found' });
    }
  }, [id]);
  useFocusRecheck(() => void recheck());

  const current = id && loaded?.id === id ? loaded : null;
  return {
    artifact: current?.artifact ?? null,
    error: current?.error ?? null,
    loading: loading || (!!id && !current),
    reload: useCallback(() => setAttempt((n) => n + 1), []),
  };
}

export interface ComposerData {
  template: ReturnType<typeof useSharedArtifact>;
  exact: ReturnType<typeof useKeyedApi<Got>>;
  purposes: ReturnType<typeof useApi<Out<'purposes.list'>>>;
  provider: ReturnType<typeof useApi<Out<'system.status'>>>;
  domains: ReturnType<typeof useApi<Out<'sendingDomains.list'>>>;
  channel: Channel | null;
  templateContent: { purpose?: string; topic?: string } | undefined;
  purpose: Out<'purposes.list'>['purposes'][number] | undefined;
  stream: Stream | null;
  rows: CheckRow[];
  refreshing: boolean;
  checkedAt: string | null;
  /** Retries only the read behind one failed row. */
  retry: (key: CheckRow['key']) => void;
}

/**
 * Every composer read, once. Provider and DNS load on entry to e-mail composition and on an
 * explicit refresh only; the template and its exact live version follow the selected reference.
 * Purpose evidence uses the exact template version that the preview renders.
 */
export function useComposerData({
  templateId,
  broadcastTopic,
  canRead,
  canAdmin,
  refreshKey,
}: {
  templateId: string | undefined;
  broadcastTopic: string | undefined;
  canRead: boolean;
  canAdmin: boolean;
  refreshKey: number;
}): ComposerData {
  const template = useSharedArtifact(templateId, refreshKey);
  const publishedVersion = template.artifact?.publishedVersion ?? null;
  // Keyed by template and version: a switch withholds the previous template's content (0.14.6 review).
  const exact = useKeyedApi(
    `${templateId ?? ''}@${publishedVersion ?? ''}`,
    () => api.call('artifacts.get', { artifactId: templateId ?? '', version: publishedVersion ?? 1 }),
    { skip: !canRead || !templateId || !publishedVersion },
  );
  // "Refresh checks" re-reads the exact live version too, even when the pointer itself did not move.
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === lastRefresh.current) return;
    lastRefresh.current = refreshKey;
    exact.reload();
  }, [refreshKey, exact.reload]);
  const purposes = useApi(() => api.call('purposes.list', {}), [refreshKey], { skip: !canRead });
  const channel = channelOfTemplate(templateId);
  const isEmail = channel === 'email';
  const provider = useApi(() => api.call('system.status', {}), [refreshKey], { skip: !canRead || !isEmail });
  const domains = useApi(() => api.call('sendingDomains.list', {}), [refreshKey], { skip: !canRead || !isEmail });

  const liveContent = publishedVersion ? exact.data?.version.content : template.artifact?.version.content;
  const templateContent =
    liveContent && typeof liveContent === 'object' ? (liveContent as { purpose?: string; topic?: string }) : undefined;
  const contentLoading = !!templateId && !template.loading && !template.error && !exact.error && !templateContent;
  const purpose = purposes.data?.purposes.find((p) => p.key === templateContent?.purpose);
  const stream = purpose ? streamOfBasis(purpose.basis) : null;

  const rows: CheckRow[] = [
    templateCheck({
      templateId,
      loading: template.loading,
      error: template.error,
      artifact: template.artifact,
      exactLoading: exact.loading,
      exactError: exact.error,
    }),
    providerCheck({
      templateId,
      channel,
      templateLoading: template.loading,
      templateError: template.error,
      purposesLoading: purposes.loading,
      purposesError: purposes.error,
      purpose,
      purposeLoading: contentLoading,
      purposeError: exact.error,
      status: provider.data,
      statusLoading: provider.loading,
      statusError: provider.error,
      canAdmin,
    }),
    domainCheck({
      templateId,
      channel,
      stream,
      data: domains.data,
      loading: domains.loading,
      error: domains.error,
      canAdmin,
    }),
    consentCheck({
      templateId,
      channel,
      templateLoading: template.loading,
      templateError: template.error,
      contentLoading,
      contentError: exact.error,
      templatePurpose: templateContent?.purpose,
      templateTopic: templateContent?.topic,
      broadcastTopic,
      purposes: purposes.data?.purposes,
      purposesLoading: purposes.loading,
      purposesError: purposes.error,
    }),
  ];

  return {
    template,
    exact,
    purposes,
    provider,
    domains,
    channel,
    templateContent,
    purpose,
    stream,
    rows,
    refreshing: template.loading || exact.loading || purposes.loading || provider.loading || domains.loading,
    checkedAt: domains.data?.checkedAt ?? null,
    retry: (key) => {
      switch (key) {
        case 'template':
          template.reload();
          exact.reload();
          break;
        case 'provider':
          provider.reload();
          break;
        case 'domain':
          domains.reload();
          break;
        case 'consent':
          template.reload();
          exact.reload();
          purposes.reload();
          break;
      }
    },
  };
}

export interface AudienceEstimateView {
  data: ComposerEstimate | undefined;
  dataVersion: number | undefined;
  /** The saved content the check measured; a draft save can replace it without a new version. */
  dataRevision: string | undefined;
  asOf: string | undefined;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * The one expensive `broadcasts.preview` read. It runs once on a clean composer and after a save
 * (a new saved version), an explicit refresh, or a moved segment pointer (a republish, including
 * one made by another tab and noticed on focus, #767); an unsaved draft never reads. Completions
 * are sequenced, so a slower response cannot replace a newer one.
 */
export function useAudienceEstimate({
  artifactId,
  version,
  savedRevision,
  dirty,
  template,
  segment,
  segmentVersion,
  enabled,
}: {
  artifactId: string;
  version: number;
  /** Changes when the saved content changes, including an in-place draft update at the same version. */
  savedRevision: string;
  dirty: boolean;
  template: string | undefined;
  segment: string | undefined;
  /** The selected segment's published pointer; undefined while it loads, null when it has none. */
  segmentVersion: number | null | undefined;
  enabled: boolean;
}): AudienceEstimateView {
  const [data, setData] = useState<{ result: ComposerEstimate; asOf: string; version: number; revision: string }>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState(0);
  const seq = useRef(0);
  const lastKey = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (!enabled || dirty || !template || !segment || segmentVersion === undefined) return;
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.call('broadcasts.preview', { artifactId, version });
      if (n !== seq.current) return;
      setData({ result, asOf: new Date().toISOString(), version, revision: savedRevision });
    } catch (e) {
      if (n !== seq.current) return;
      setError(errText(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [artifactId, version, savedRevision, dirty, template, segment, segmentVersion, enabled]);

  // One read per saved version, per mount and per explicit refresh. Returning to a clean draft
  // after unsaved edits does not re-run the expensive command: nothing was saved in between.
  useEffect(() => {
    if (!enabled || dirty || !template || !segment || segmentVersion === undefined) return;
    const key = `${artifactId}:${version}:${savedRevision}:${segmentVersion ?? 'none'}:${request}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    void run();
  }, [artifactId, version, savedRevision, segmentVersion, dirty, template, segment, enabled, request, run]);

  return {
    data: data?.result,
    dataVersion: data?.version,
    dataRevision: data?.revision,
    asOf: data?.asOf,
    error,
    loading,
    refresh: useCallback(() => setRequest((n) => n + 1), []),
  };
}
