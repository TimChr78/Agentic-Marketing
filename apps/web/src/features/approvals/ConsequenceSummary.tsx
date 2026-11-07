import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { api, type Out } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, JsonView, StatusPill } from '../../ui';
import { formatDateTime } from '../../ui/time';
import { getArtifact } from '../artifactCache';
import { ConditionView } from '../previews/ConditionView';
import { useSharedRead } from '../previews/previewRead';
import {
  type BroadcastAudience,
  buildReadPlan,
  type ConsequenceEvidence,
  type ConsequenceRow,
  type DomainEvidence,
  deriveConsequences,
  type ProviderEvidence,
  type PurposeInfo,
  type ResolvedDependencies,
  type TemplateCheck,
} from './consequences';

type Detail = Out<'approvals.get'>;

const evidenceTone = (status: ConsequenceEvidence['status']) =>
  status === 'ready' ? 'good' : status === 'attention' ? 'warn' : status === 'not-applicable' ? 'neutral' : 'warn';
const evidenceLabel = (status: ConsequenceEvidence['status']) =>
  status === 'ready'
    ? 'Ready'
    : status === 'attention'
      ? 'Needs attention'
      : status === 'not-applicable'
        ? 'Not applicable'
        : 'Not checked';

/**
 * Names and publication pointers for the reviewed content's references. `getArtifact` caches by id
 * for the session, so a repeated reference is one read, and every unique id is read once per
 * review. A missing artifact is shown as unavailable, never as "no dependencies".
 */
function useArtifactDependencies(ids: string[]) {
  const key = [...ids].sort().join(',');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ data: ResolvedDependencies; loading: boolean; error: string | null }>({
    data: {},
    loading: false,
    error: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit retry counter; the body reads key only
  useEffect(() => {
    let live = true;
    let failed = false;
    const list = key ? key.split(',') : [];
    if (!list.length) {
      setState({ data: {}, loading: false, error: null });
      return;
    }
    setState({ data: {}, loading: true, error: null });
    Promise.all(
      list.map(async (id) => {
        try {
          const a = await getArtifact(id);
          return [id, { id, name: a.name, type: a.type, publishedVersion: a.publishedVersion, latestVersion: a.latestVersion }] as const;
        } catch {
          failed = true;
          return [id, { id, unavailable: true }] as const;
        }
      }),
    ).then((rows) => {
      if (live)
        setState({
          data: Object.fromEntries(rows),
          loading: false,
          error: failed ? 'Some referenced artifacts could not be read.' : null,
        });
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);
  return { ...state, reload: () => setAttempt((n) => n + 1) };
}

/**
 * The consequence summary (#498): what publishes, who it reaches, when, what it depends on, and
 * the evidence and consent signals separated from each other. It renders from the reviewed
 * `approvals.get` content; extra reads only annotate it and never replace the reviewed definition.
 */
export function ConsequenceSummary({ approval, bundleVersions }: { approval: Detail; bundleVersions?: Record<string, number> }) {
  const { can } = useSession();
  const headingId = useId();
  const type = approval.artifactType;
  const content = (approval.content ?? {}) as Record<string, unknown>;
  const plan = buildReadPlan({
    artifactId: approval.artifactId,
    type,
    content,
    version: approval.version,
    bundleVersions,
    capabilities: { canReadArtifacts: can('artifacts:read'), canReadProfiles: can('profiles:read') },
  });
  const dependencies = useArtifactDependencies(plan.artifacts);
  const purposes = useApi(() => api.call('purposes.list', {}), [], { skip: !plan.purposes });
  const provider = useApi(() => api.call('system.status', {}), [], { skip: !plan.provider });
  const domains = useApi(() => api.call('sendingDomains.list', {}), [], { skip: !plan.domains });
  // One shared result per command + input: the summary and the renderer below it (the e-mail
  // preview, checks panel, broadcast or segment preview) issue the same read once (#498 review).
  const broadcast = useSharedRead('broadcasts.preview', plan.broadcast ?? {}, () => api.call('broadcasts.preview', plan.broadcast!), {
    skip: !plan.broadcast,
  });
  const broadcastAudience = useMemo<BroadcastAudience | null>(
    // `as of` is the client completion time, not a server snapshot timestamp.
    () => (broadcast.data ? { ...broadcast.data, completedAt: new Date().toISOString() } : null),
    [broadcast.data],
  );
  const templatePreview = useSharedRead(
    'templates.preview',
    plan.templatePreview ?? {},
    () => api.call('templates.preview', plan.templatePreview!),
    { skip: !plan.templatePreview },
  );
  const templateCheck = useSharedRead('templates.check', plan.templateCheck ?? {}, () => api.call('templates.check', plan.templateCheck!), {
    skip: !plan.templateCheck,
  });
  const segment = useSharedRead('segments.preview', plan.segmentPreview ?? {}, () => api.call('segments.preview', plan.segmentPreview!), {
    skip: !plan.segmentPreview,
  });

  const templateId = type === 'broadcast' && typeof content.template === 'string' ? content.template : undefined;
  const templateVersion = templateId
    ? (bundleVersions?.[templateId] ?? dependencies.data[templateId]?.publishedVersion ?? undefined)
    : undefined;
  // Shared with the review panel, which resolves the nested template's block pins from the same read.
  const templateContent = useSharedRead(
    'artifacts.get',
    { artifactId: templateId, version: templateVersion },
    () => api.call('artifacts.get', { artifactId: templateId!, version: templateVersion! }),
    { skip: !templateId || templateVersion == null || !can('artifacts:read') },
  );
  const templatePurpose =
    type === 'broadcast' && templateContent.data
      ? (() => {
          const t = (templateContent.data.version.content ?? {}) as Record<string, unknown>;
          return { purpose: String(t.purpose ?? ''), ...(typeof t.topic === 'string' ? { topic: t.topic } : {}) };
        })()
      : null;

  const model = deriveConsequences({
    artifactId: approval.artifactId,
    type,
    name: approval.artifactName,
    version: approval.version,
    publishedVersion: approval.publishedVersion,
    latestVersion: approval.artifactLatestVersion,
    status: approval.status,
    content: approval.content,
    bundleVersions,
    dependencies: dependencies.data,
    dependenciesLoading: dependencies.loading,
    dependenciesError: dependencies.error,
    purposes: (purposes.data?.purposes as PurposeInfo[] | undefined) ?? null,
    purposesError: purposes.error,
    templatePurpose,
    templatePurposeError: templateContent.error,
    templatePreview: templatePreview.data ?? null,
    templatePreviewError: templatePreview.error,
    templateCheck: (templateCheck.data as unknown as TemplateCheck | undefined) ?? null,
    templateCheckError: templateCheck.error,
    broadcastAudience,
    audienceError: broadcast.error,
    segmentCount: segment.data ? { count: segment.data.count } : null,
    segmentCountRestricted: !can('profiles:read'),
    segmentCountError: segment.error,
    provider: (provider.data?.emailProvider as ProviderEvidence | undefined) ?? null,
    providerError: provider.error,
    domains: (domains.data as unknown as DomainEvidence | undefined) ?? null,
    domainsError: domains.error,
    evidenceLoading: provider.loading || domains.loading,
    formatWhen: (iso) => formatDateTime(iso, { zone: true }),
  });

  const consent = model.evidence.filter((e) => e.key === 'consent-purpose');
  const evidence = model.evidence.filter((e) => e.key !== 'consent-purpose');
  const retryAudience = () => (type === 'segment' ? segment.refresh() : broadcast.refresh());

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface-2 px-4 py-4">
      <h2 id={headingId} className="text-[16px] leading-6 font-semibold">
        {model.heading}
      </h2>
      <dl className="mt-3 space-y-3 text-[13px] leading-5">
        {model.rows.map((row) => (
          <ConsequenceRowView key={row.key} row={row} />
        ))}
      </dl>

      {dependencies.error && (
        <Alert tone="warn" title="Some dependencies could not be read" onRetry={dependencies.reload} className="mt-3">
          The reviewed content is unchanged; references that failed stay visible as Unavailable.
        </Alert>
      )}

      {model.audience && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12px] text-muted">{model.audience.label}</p>
              <p className="text-[18px] leading-6 font-semibold tabular-nums">{model.audience.value}</p>
            </div>
            {(model.audience.unavailable || (plan.broadcast ?? plan.segmentPreview)) && (
              <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={retryAudience} title="Run the audience check again">
                {model.audience.unavailable ? 'Retry' : 'Refresh'}
              </Button>
            )}
          </div>
          {model.audience.notes.map((note) => (
            <p key={note} className="mt-1 text-[12px] leading-[18px] text-muted">
              {note}
            </p>
          ))}
        </div>
      )}

      {consent.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="text-[13px] font-semibold">Consent</h3>
          <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
            Consent is checked per person at send time; this is not a claim that the whole audience consented.
          </p>
          <EvidenceList rows={consent} />
        </div>
      )}

      {evidence.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="text-[13px] font-semibold">Evidence</h3>
          <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
            What the system can check now. Server validation and publish policy remain authoritative.
          </p>
          <EvidenceList rows={evidence} />
          {(provider.error || domains.error || purposes.error) && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={13} />}
              className="mt-2"
              onClick={() => {
                provider.reload();
                domains.reload();
                purposes.reload();
              }}
            >
              Retry checks
            </Button>
          )}
        </div>
      )}

      {model.templateCheck && <TemplateChecks check={model.templateCheck} />}
      {templateCheck.error && (
        <Alert tone="warn" title="Pre-send checks unavailable" onRetry={templateCheck.refresh} className="mt-3">
          {templateCheck.error}
        </Alert>
      )}

      {model.notes.map((note) => (
        <p key={note} className="mt-3 text-[12px] leading-[18px] text-muted">
          {note}
        </p>
      ))}
    </section>
  );
}

function ConsequenceRowView({ row }: { row: ConsequenceRow }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[12px] text-muted sm:text-[13px]">{row.label}</dt>
      <dd className="min-w-0 text-fg">
        {row.value && <p className={row.tone === 'bad' ? 'text-bad' : row.tone === 'warn' ? 'text-warn' : undefined}>{row.value}</p>}
        {row.items && (
          <ul className="space-y-1.5">
            {row.items.map((item) => (
              <li key={item.key} className="min-w-0">
                <span className={item.tone === 'bad' ? 'text-bad' : item.tone === 'warn' ? 'text-warn' : undefined}>{item.value}</span>
                {item.note && <span className="mt-0.5 block text-[12px] leading-[18px] text-muted">{item.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {row.condition !== undefined && (
          <div className="mt-2 rounded-md border border-line bg-surface px-3 py-2.5">
            <ConditionView condition={row.condition} />
          </div>
        )}
        {row.notes?.map((note) => (
          <p key={note} className="mt-0.5 text-[12px] leading-[18px] text-muted">
            {note}
          </p>
        ))}
        {row.details?.map((detail) => (
          <details key={detail.label} className="mt-2 rounded-md border border-line bg-surface">
            <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-fg-2">{detail.label}</summary>
            <div className="px-3 pb-3">
              <JsonView value={detail.value} maxHeight={240} />
            </div>
          </details>
        ))}
        {row.html?.map((variant) => (
          <div key={variant.label} className="mt-2 overflow-hidden rounded-md border border-line bg-white">
            <p className="border-b border-line px-3 py-1.5 text-[12px] text-muted">{variant.label}</p>
            {/* sandbox="" means no scripts and no same-origin access; it is a rendering, not a host. */}
            <iframe title={variant.label} sandbox="" srcDoc={variant.html} className="block w-full" style={{ height: 180 }} />
          </div>
        ))}
      </dd>
    </div>
  );
}

function EvidenceList({ rows }: { rows: ConsequenceEvidence[] }) {
  return (
    <ul className="mt-1.5 space-y-1.5">
      {rows.map((row) => (
        <li key={row.key} className="min-w-0 text-[13px] leading-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] text-muted sm:min-w-[116px]">{row.label}</span>
            <StatusPill tone={evidenceTone(row.status)}>{evidenceLabel(row.status)}</StatusPill>
            <span className="min-w-0 break-words text-fg-2">{row.value}</span>
          </div>
          {row.detail && <p className="mt-0.5 text-[12px] leading-[18px] text-muted">{row.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

function TemplateChecks({ check }: { check: TemplateCheck }) {
  const { blocking, warning, info } = check.summary;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[13px] font-semibold">Pre-send checks</h3>
      <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
        {blocking === 0 && warning === 0 && info === 0
          ? 'No findings'
          : `${blocking} blocking · ${warning} warning${warning === 1 ? '' : 's'} · ${info} note${info === 1 ? '' : 's'}`}
        {' · checked '}
        {formatDateTime(check.checkedAt, { zone: true })}
      </p>
      {check.findings.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {check.findings.map((finding) => (
            <li key={finding.id} className="rounded-md border border-line bg-surface px-3 py-2 text-[13px] leading-5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={finding.severity === 'blocking' ? 'bad' : finding.severity === 'warning' ? 'warn' : 'neutral'}>
                  {finding.severity === 'blocking' ? 'Blocking' : finding.severity === 'warning' ? 'Warning' : 'Note'}
                </StatusPill>
                <span className="text-[12px] text-muted">{finding.category}</span>
                {finding.location && <span className="text-[12px] text-muted">{finding.location}</span>}
              </div>
              <p className="mt-1 text-fg-2">{finding.message}</p>
              {finding.fix && <p className="mt-0.5 text-[12px] text-muted">Fix: {finding.fix}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
