import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errText, type Out } from '../../../app/api';
import { useApi } from '../../../app/useApi';
import { getArtifact } from '../../artifactCache';
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

/**
 * The template artifact through the shared cache, with its own loading/error so the checklist can
 * offer a local retry. It does not duplicate the cache read the page and preview already share.
 */
export function useSharedArtifact(id: string | undefined | null) {
  const [artifact, setArtifact] = useState<Got | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the explicit retry trigger, not read by the effect body
  useEffect(() => {
    if (!id) {
      setArtifact(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    getArtifact(id)
      .then((a) => {
        if (live) {
          setArtifact(a);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setArtifact(null);
          setError(e?.message ?? 'Not found');
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [id, attempt]);

  return {
    artifact,
    error,
    loading,
    reload: useCallback(() => setAttempt((n) => n + 1), []),
  };
}

export interface ComposerData {
  template: ReturnType<typeof useSharedArtifact>;
  exact: ReturnType<typeof useApi<Got>>;
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
  const template = useSharedArtifact(templateId);
  const publishedVersion = template.artifact?.publishedVersion ?? null;
  const exact = useApi(
    () => api.call('artifacts.get', { artifactId: templateId ?? '', version: publishedVersion ?? 1 }),
    [templateId, publishedVersion],
    { skip: !canRead || !templateId || !publishedVersion },
  );
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
 * (a new saved version) or an explicit refresh; an unsaved draft never reads. Completions are
 * sequenced, so a slower response cannot replace a newer one.
 */
export function useAudienceEstimate({
  artifactId,
  version,
  savedRevision,
  dirty,
  template,
  segment,
  enabled,
}: {
  artifactId: string;
  version: number;
  /** Changes when the saved content changes, including an in-place draft update at the same version. */
  savedRevision: string;
  dirty: boolean;
  template: string | undefined;
  segment: string | undefined;
  enabled: boolean;
}): AudienceEstimateView {
  const [data, setData] = useState<{ result: ComposerEstimate; asOf: string; version: number; revision: string }>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState(0);
  const seq = useRef(0);
  const lastKey = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (!enabled || dirty || !template || !segment) return;
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
  }, [artifactId, version, savedRevision, dirty, template, segment, enabled]);

  // One read per saved version, per mount and per explicit refresh. Returning to a clean draft
  // after unsaved edits does not re-run the expensive command: nothing was saved in between.
  useEffect(() => {
    if (!enabled || dirty || !template || !segment) return;
    const key = `${artifactId}:${version}:${savedRevision}:${request}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    void run();
  }, [artifactId, version, savedRevision, dirty, template, segment, enabled, request, run]);

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
