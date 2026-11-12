import { Check, ExternalLink, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errText, type Out } from '../../app/api';
import { artifactPath, typeLabel } from '../../app/artifactRoutes';
import { TextLink } from '../../app/links';
import { Link, navigate } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useKeyedApi } from '../../app/useApi';
import {
  Alert,
  Button,
  DiffView,
  Drawer,
  Field,
  formatDateTime,
  JsonView,
  LoadingBlock,
  Meta,
  StatusPill,
  Tabs,
  Textarea,
  timeAgo,
  useToast,
} from '../../ui';
import { getArtifact, invalidateArtifact } from '../artifactCache';
import { BlockUsage } from '../blocks/BlockUsage';
import { ArtifactPreview } from '../previews/ArtifactPreview';
import { type BlockGuard, BundledBlocks } from '../previews/BundledBlocks';
import { PreviewReadProvider, useSharedRead } from '../previews/previewRead';
import { type PreviewStatus, PreviewStatusProvider, ReportPreviewStatus } from '../previews/previewStatus';
import { type BlockRef, bundleMemberSummary, resolveBlockPins } from './bundleSummary';
import { ConsequenceSummary } from './ConsequenceSummary';
import { blockIdsIn } from './consequences';
import { HoldBadge } from './HoldBadge';
import { holdCountdownText, useNow } from './holds';
import { RequesterView } from './requester';
import { markViewed } from './viewed';

type Detail = Out<'approvals.get'>;
type Tab = 'review' | 'content' | 'history';

const artifactHeading = (type: string) => {
  if (type === 'broadcast' || type === 'email_template' || type === 'sms_template' || type === 'push_template') return 'The message';
  if (type === 'journey') return 'The journey';
  if (type === 'segment') return 'The segment';
  if (type === 'form') return 'The form';
  if (type === 'experience') return 'The experience';
  return 'The artifact';
};

/**
 * Review drawer (#41, #498): the exact version under review, opened by its consequence summary,
 * then the requester's note and the rendered artifact, then what changed against the live
 * version. Approve / Reject stay in the footer. Deep link: /approvals/<id>.
 *
 * The contract's read order is Review → Content → History; the old Preview/Changes split is gone.
 */
export function ApprovalDrawer({
  id,
  queue,
  onClose,
  onDecided,
}: {
  id: string;
  queue: string[];
  onClose: () => void;
  onDecided: () => void;
}) {
  const { can, user, workspace } = useWorkspace();
  const toast = useToast();
  // The drawer is reused when the URL id advances, so the read must be keyed by that id (#612).
  const d = useKeyedApi(id, () => api.call('approvals.get', { approvalId: id }));
  const [tab, setTab] = useState<Tab>('review');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'test'>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const focusRejectOnCancel = useRef(false);

  // Cancelling a rejection returns focus to the Reject button that revealed the reason field.
  useEffect(() => {
    if (rejecting || !focusRejectOnCancel.current) return;
    focusRejectOnCancel.current = false;
    rejectButtonRef.current?.focus();
  }, [rejecting]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the dialog state whenever a different approval is opened
  useEffect(() => {
    setTab('review');
    setRejecting(false);
    setReason('');
    setActionError(null);
  }, [id]);

  // Only data for the id in the address bar may drive the review or its actions.
  const staleRead = !!d.data && d.data.id !== id;
  const a = d.data?.id === id ? d.data : undefined;
  const loading = d.loading || staleRead;
  const pending = a?.status === 'pending';
  const held = !!a?.holdUntil && pending;
  // Reviewed together with other changes (#107): deciding this one decides all of them.
  const bundle = a?.bundle ?? null;
  const bundleVersions = bundle ? Object.fromEntries(bundle.members.map((m) => [m.artifactId, m.version])) : undefined;
  const bundledTemplate =
    a?.artifactType === 'broadcast' ? bundleVersions?.[String((a.content as { template?: string }).template ?? '')] : undefined;
  const canApprove = can('artifacts:approve');
  const ownRequest = a?.requestedBy.type === 'user' && a.requestedBy.id === user.id;
  // Approvers can test to their own address (the commands accept artifacts:approve without `to`).
  const testable =
    a &&
    (can('artifacts:write') || can('artifacts:approve')) &&
    (a.artifactType === 'email_template' ||
      (a.artifactType === 'broadcast' && String((a.content as { template?: string }).template ?? '').startsWith('eml_')));

  const next = () => {
    const i = queue.indexOf(id);
    const after = queue.filter((x, k) => x !== id && k > i)[0] ?? queue.find((x) => x !== id);
    if (after) navigate(`/approvals/${after}`);
    else onClose();
  };

  const decide = async (kind: 'approve' | 'reject') => {
    if (!a) return;
    if (kind === 'reject' && !reason.trim()) {
      setReasonError('Say what to change, so the author can fix it.');
      return;
    }
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === 'approve') await api.call('approvals.approve', { approvalId: a.id });
      else await api.call('approvals.reject', { approvalId: a.id, note: reason.trim() });
      for (const m of bundle?.members ?? [a]) invalidateArtifact(m.artifactId);
      const what = bundle
        ? `${bundle.members.length} changes (${bundle.members.map((m) => `“${m.artifactName}”`).join(', ')})`
        : `“${a.artifactName}”`;
      toast.success(
        kind === 'approve'
          ? bundle
            ? `${held ? 'Ran' : 'Approved'} ${what}. They are live.`
            : `${held ? 'Ran' : 'Approved'} ${what}. Version ${a.version} is live.`
          : `${held ? 'Vetoed' : 'Rejected'} ${what}. The author sees your reason.`,
      );
      onDecided();
      next();
    } catch (e) {
      setActionError(errText(e));
      // A conflict refreshes the request in place; it must never silently move to another version.
      if (e instanceof ApiError && e.status === 409) void d.reload();
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    if (!a) return;
    setBusy('test');
    try {
      const r =
        a.artifactType === 'broadcast'
          ? await api.call('broadcasts.sendTest', { artifactId: a.artifactId, version: a.version, templateVersion: bundledTemplate })
          : await api.call('templates.sendTest', { artifactId: a.artifactId, version: a.version });
      toast.success(`Test sent to ${r.to}: “${r.subject}”.`);
    } catch (e) {
      toast.error(`The test was not sent: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const stale = !!a && a.artifactLatestVersion > a.version;
  return (
    <Drawer
      open
      onClose={onClose}
      width="xl"
      title={
        // Focus lands on the heading when the drawer opens; a deep link has no invoking row.
        <span data-autofocus tabIndex={-1} className="outline-none">
          {a?.artifactName ?? 'Loading the approval request'}
        </span>
      }
      meta={
        a && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {typeLabel(a.artifactType)} · Reviewing Saved v{a.version} ·{' '}
              {a.publishedVersion ? `Published v${a.publishedVersion}` : 'Nothing live yet'}
            </span>
            {held && <HoldBadge />}
            {a.status !== 'pending' && (
              <StatusPill tone={a.status === 'approved' ? 'good' : 'bad'}>
                {a.status === 'approved' ? 'Approved' : a.status === 'rejected' ? 'Rejected' : 'Withdrawn'}
              </StatusPill>
            )}
          </span>
        )
      }
      actions={
        a && (
          <TextLink to={artifactPath(a.artifactType, a.artifactId)} className="mr-1 hidden items-center gap-1 text-[13px] sm:inline-flex">
            Open <ExternalLink size={13} aria-hidden />
          </TextLink>
        )
      }
      footer={
        a &&
        pending && (
          <div className="w-full space-y-3">
            {actionError && <Alert tone="bad">{actionError}</Alert>}
            {rejecting && (
              <Field
                label={held ? 'Why are you vetoing it?' : 'Why are you rejecting it?'}
                hint={
                  held
                    ? 'The agent’s mandate is told why its held change was vetoed; it can propose a corrected version.'
                    : 'The author (person or agent) sees this and can submit a fixed version.'
                }
                error={reasonError}
                required
              >
                <Textarea
                  rows={3}
                  value={reason}
                  data-autofocus
                  autoFocus
                  onChange={(e) => {
                    setReason(e.target.value);
                    setReasonError(null);
                  }}
                  onBlur={() => !reason.trim() && setReasonError('Say what to change, so the author can fix it.')}
                />
              </Field>
            )}
            {!canApprove ? (
              <p className="text-[13px] text-muted">Your role can review changes but not approve them.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {testable && (
                  <Button
                    className="w-full sm:w-auto"
                    icon={<Send size={14} />}
                    mutation
                    loading={busy === 'test'}
                    onClick={sendTest}
                    title="Send a [Test] copy of this version to your own address"
                  >
                    Send me a test
                  </Button>
                )}
                <div className="ml-auto flex w-full flex-wrap justify-end gap-2 sm:w-auto">
                  {rejecting ? (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          focusRejectOnCancel.current = true;
                          setRejecting(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button variant="danger" icon={<X size={14} />} mutation loading={busy === 'reject'} onClick={() => decide('reject')}>
                        {bundle
                          ? `${held ? 'Veto' : 'Reject'} all ${bundle.members.length} with reason`
                          : held
                            ? 'Veto with reason'
                            : 'Reject with reason'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button ref={rejectButtonRef} variant="danger" icon={<X size={14} />} mutation onClick={() => setRejecting(true)}>
                        {held ? (bundle ? 'Veto all' : 'Veto') : bundle ? 'Reject all' : 'Reject'}
                      </Button>
                      <Button
                        variant="primary"
                        icon={<Check size={14} />}
                        mutation
                        loading={busy === 'approve'}
                        onClick={() => decide('approve')}
                      >
                        {held
                          ? bundle
                            ? `Run all ${bundle.members.length} now`
                            : 'Run now'
                          : bundle
                            ? `Approve all ${bundle.members.length} and publish`
                            : 'Approve and publish'}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      }
    >
      {loading ? (
        <LoadingBlock geometry="detail" label="Loading the approval request" />
      ) : d.error ? (
        <div className="p-5">
          <Alert tone="bad" title="Couldn't open this approval request" onRetry={d.reload}>
            {d.error}
          </Alert>
        </div>
      ) : a ? (
        <PreviewReadProvider>
          <div className="space-y-5 p-4 sm:p-5">
            {/* The consequence summary is the context for every tab, exactly as the mock-up shows:
              notices and summary, then the requester's note, then Review / Content / History. */}
            <ReviewContext
              approval={a}
              bundle={bundle}
              bundleVersions={bundleVersions}
              stale={stale}
              pending={pending}
              ownRequest={!!ownRequest}
              workspaceApprovalPolicy={workspace.approvalPolicy}
            />
            <Tabs
              label="Review"
              value={tab}
              onChange={setTab}
              items={[
                { key: 'review', label: 'Review' },
                { key: 'content', label: 'Content' },
                { key: 'history', label: 'History' },
              ]}
            >
              {tab === 'review' && <ReviewPanel approval={a} bundleVersions={bundleVersions} />}
              {tab === 'content' && (
                <JsonView value={a.content} label={`Version ${a.version} as JSON (what agents read and write)`} maxHeight={600} />
              )}
              {tab === 'history' && <History a={a} />}
            </Tabs>
          </div>
        </PreviewReadProvider>
      ) : null}
    </Drawer>
  );
}

function ReviewContext({
  approval,
  bundle,
  bundleVersions,
  stale,
  pending,
  ownRequest,
  workspaceApprovalPolicy,
}: {
  approval: Detail;
  bundle: Detail['bundle'];
  bundleVersions?: Record<string, number>;
  stale: boolean;
  pending: boolean;
  ownRequest: boolean;
  workspaceApprovalPolicy: string;
}) {
  const now = useNow();
  const held = !!approval.holdUntil && pending;
  return (
    <div className="space-y-5">
      {stale && (
        <Alert tone="warn" title={`A newer draft (v${approval.artifactLatestVersion}) exists`}>
          Approving publishes v{approval.version}, the one shown here. The newer draft stays a draft.
        </Alert>
      )}
      {ownRequest && pending && workspaceApprovalPolicy === 'all_publishes' && (
        <Alert tone="info">You submitted this yourself. Under four-eyes review, another person has to approve it.</Alert>
      )}
      {held && approval.holdUntil && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
          <HoldBadge />
          <span className="text-[13px] text-fg">{holdCountdownText(approval.holdUntil, now)}</span>
          <span className="text-[12px] text-muted">
            · runs {formatDateTime(approval.holdUntil, { zone: true })}. Run it now, or veto it and say why.
          </span>
        </div>
      )}
      {bundle && <BundlePanel bundle={bundle} current={approval} pending={pending} />}

      <ConsequenceSummary approval={approval} bundleVersions={bundleVersions} />

      <section aria-label="Request" className="rounded-lg border border-line bg-surface-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <RequesterView r={approval.requester} className="font-medium text-fg" />
          <span className="text-muted" title={formatDateTime(approval.createdAt, { zone: true })}>
            asked {timeAgo(approval.createdAt)}
          </span>
        </div>
        {approval.note && <p className="mt-2 text-[14px] leading-[22px] whitespace-pre-wrap text-fg">{approval.note}</p>}
      </section>

      {approval.artifactType === 'email_block' && <BlockUsage artifactId={approval.artifactId} />}
    </div>
  );
}

function useBlockRefs(ids: string[]) {
  const key = [...ids].sort().join(',');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ data: Record<string, BlockRef>; loading: boolean; error: string | null }>({
    data: {},
    loading: !!key,
    error: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit retry counter; the body reads key only
  useEffect(() => {
    let live = true;
    const list = key ? key.split(',') : [];
    if (!list.length) {
      setState({ data: {}, loading: false, error: null });
      return;
    }
    setState({ data: {}, loading: true, error: null });
    Promise.all(
      list.map(async (id): Promise<readonly [string, BlockRef]> => {
        try {
          const artifact = await getArtifact(id);
          return [id, { publishedVersion: artifact.publishedVersion }];
        } catch {
          return [id, { publishedVersion: null, missing: true }];
        }
      }),
    ).then((rows) => {
      if (!live) return;
      setState({
        data: Object.fromEntries(rows),
        loading: false,
        error: rows.some(([, ref]) => ref.missing) ? 'Some reusable blocks could not be read.' : null,
      });
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);
  return { ...state, reload: () => setAttempt((n) => n + 1) };
}

/**
 * The template a review renders, exact: the reviewed e-mail template itself, or the broadcast's
 * nested template at its bundle override or its published version. Block ids come from that exact
 * content, never from the live version (#498 review).
 */
function useReviewedTemplate(approval: Detail, bundleVersions?: Record<string, number>) {
  const content = (approval.content ?? {}) as { template?: string; mjml?: string };
  const direct = approval.artifactType === 'email_template';
  const templateId = direct
    ? approval.artifactId
    : approval.artifactType === 'broadcast' && content.template?.startsWith('eml_')
      ? content.template
      : undefined;
  const bundledVersion = templateId ? bundleVersions?.[templateId] : undefined;
  // A bundled template's version is known from the bundle; an unbundled one uses its published
  // pointer, read once through the session cache shared with the consequence summary.
  const needsPointer = !direct && !!templateId && bundledVersion == null;
  const [attempt, setAttempt] = useState(0);
  const [pointer, setPointer] = useState<{ artifact: Out<'artifacts.get'> | null; loading: boolean; error: string | null }>({
    artifact: null,
    loading: needsPointer,
    error: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the template id and the explicit retry counter
  useEffect(() => {
    if (!needsPointer || !templateId) {
      setPointer({ artifact: null, loading: false, error: null });
      return;
    }
    let live = true;
    setPointer({ artifact: null, loading: true, error: null });
    getArtifact(templateId)
      .then((artifact) => live && setPointer({ artifact, loading: false, error: null }))
      .catch((e: Error) => live && setPointer({ artifact: null, loading: false, error: e.message ?? 'Not found' }));
    return () => {
      live = false;
    };
  }, [templateId, needsPointer, attempt]);

  const version = direct ? approval.version : (bundledVersion ?? pointer.artifact?.publishedVersion ?? undefined);
  // Shared with the consequence summary: one exact artifacts.get per template version per review.
  const read = useSharedRead(
    'artifacts.get',
    { artifactId: templateId, version },
    () => api.call('artifacts.get', { artifactId: templateId!, version: version! }),
    { skip: !templateId || direct || version == null },
  );
  const readLoading = !!templateId && !direct && version != null && read.loading && read.data === undefined && !read.error;
  const loading = direct ? false : (needsPointer && pointer.loading) || readLoading;
  const error = direct ? null : ((needsPointer ? pointer.error : null) ?? (version != null ? read.error : null));
  const templateContent = direct ? approval.content : read.data?.version.content;
  const retry = () => {
    setAttempt((n) => n + 1);
    if (!direct && templateId && version != null) read.refresh();
  };
  return { templateId, version, content: templateContent, loading, error, retry };
}

function ReviewPanel({ approval, bundleVersions }: { approval: Detail; bundleVersions?: Record<string, number> }) {
  const { user } = useWorkspace();
  const reviewKey = `${approval.id}:${approval.version}`;
  // Readiness of every renderer in this Review. A request is viewed only when all of them have
  // loaded successfully; a loading or failed preview never marks it (#498).
  const [statuses, setStatuses] = useState<{ key: string; byId: Record<string, PreviewStatus> }>({ key: '', byId: {} });
  const report = useCallback(
    (id: string, status: PreviewStatus) => {
      setStatuses((previous) => {
        if (previous.key !== reviewKey) return { key: reviewKey, byId: { [id]: status } };
        if (previous.byId[id] === status) return previous;
        return { key: reviewKey, byId: { ...previous.byId, [id]: status } };
      });
    },
    [reviewKey],
  );
  const currentStatuses = statuses.key === reviewKey ? statuses.byId : {};
  const reported = Object.values(currentStatuses);
  const ready = statuses.key === reviewKey && reported.length > 0 && reported.every((status) => status === 'ready');

  useEffect(() => {
    if (ready && user && approval.status === 'pending') markViewed(user.id, approval.id, approval.version);
  }, [ready, user, approval.id, approval.version, approval.status]);

  const template = useReviewedTemplate(approval, bundleVersions);
  const blockIds =
    template.content && typeof (template.content as { mjml?: unknown }).mjml === 'string'
      ? blockIdsIn((template.content as { mjml: string }).mjml)
      : [];
  const refs = useBlockRefs(blockIds);
  const pins = resolveBlockPins(blockIds, bundleVersions, refs.data);
  const blocksLoading = template.loading || (blockIds.length > 0 && refs.loading);
  const blocksError = template.error ?? refs.error;
  // The server expands published block vN; a bundle pin that differs (or has nothing published)
  // cannot be reproduced by the combined message render.
  const reproducible = !blocksLoading && !blocksError && pins.every((pin) => pin.reproducible);
  // A block with no exact version at all has no successful preview, so this review is not viewable.
  const blockUnavailable = pins.some((pin) => pin.version == null);
  const blocksStatus: PreviewStatus = blocksLoading ? 'loading' : blocksError || blockUnavailable ? 'error' : 'ready';
  const retryBlocks = () => {
    template.retry();
    refs.reload();
  };
  // A broadcast renders its nested template itself, so the same pin guard has to travel with it.
  const broadcastGuard: BlockGuard | undefined =
    approval.artifactType === 'broadcast' && template.templateId
      ? {
          pins,
          loading: blocksLoading,
          error: blocksError,
          reproducible,
          unavailable: blockUnavailable,
          templateContent: template.content,
          templateVersion: template.version,
          onRetry: retryBlocks,
        }
      : undefined;

  return (
    <PreviewStatusProvider onChange={report}>
      <ReportPreviewStatus id="blocks" status={blocksStatus} />
      <div className="space-y-5">
        <section aria-labelledby="review-artifact-heading" className="space-y-2">
          <h3 id="review-artifact-heading" className="text-[15px] leading-6 font-semibold">
            {artifactHeading(approval.artifactType)}
          </h3>
          {approval.artifactType === 'email_template' && !reproducible ? (
            blocksLoading ? (
              <LoadingBlock lines={4} label="Resolving reusable blocks" />
            ) : (
              <div className="space-y-3">
                <Alert
                  tone={blocksError ? 'bad' : 'warn'}
                  title={
                    blocksError ? 'Couldn’t read this template’s reusable blocks' : 'Bundled block render unavailable before publication'
                  }
                  {...(blocksError ? { onRetry: retryBlocks } : {})}
                >
                  {blocksError
                    ? 'The combined message is withheld until every reusable block can be resolved. The exact reviewed content is shown below.'
                    : 'The server expands each block at its published version, so it cannot render this bundle’s block pins. The exact reviewed content is shown below, and each block is previewed separately at the version this review would use.'}
                </Alert>
                <JsonView
                  value={approval.content}
                  label={`Version ${approval.version} as JSON (the exact reviewed content)`}
                  maxHeight={480}
                />
              </div>
            )
          ) : (
            <ArtifactPreview
              type={approval.artifactType}
              artifactId={approval.artifactId}
              version={approval.version}
              content={approval.content}
              compact
              bundle={bundleVersions}
              blockGuard={broadcastGuard}
              source={{ kind: 'saved', version: approval.version }}
              sourceSuffix="Under review"
            />
          )}
        </section>

        {approval.artifactType === 'email_template' && (
          <BundledBlocks pins={pins} loading={blocksLoading} error={refs.error} onRetry={retryBlocks} />
        )}

        <section aria-labelledby="review-changes-heading" className="space-y-2">
          <h3 id="review-changes-heading" className="text-[15px] leading-6 font-semibold">
            Changes · {approval.diff.changes.length}
          </h3>
          <details open className="rounded-lg border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-medium text-fg-2">Before and after</summary>
            <div className="mt-3">
              <DiffView changes={approval.diff.changes} from={approval.diff.from} to={approval.diff.to} />
            </div>
          </details>
        </section>
      </div>
    </PreviewStatusProvider>
  );
}

function BundlePanel({ bundle, current, pending }: { bundle: NonNullable<Detail['bundle']>; current: Detail; pending: boolean }) {
  return (
    <section aria-label="Reviewed together" className="rounded-lg border border-line px-4 py-3">
      <h3 className="text-[14px] leading-5 font-semibold">Reviewed together</h3>
      <p className="mt-1 text-[13px] leading-5 text-fg-2">
        <strong className="font-medium text-fg">Publishes {bundle.members.length} changes together.</strong>{' '}
        {pending ? 'Approving publishes all of them, in this order, in one step; rejecting rejects all.' : 'These were decided together.'}
      </p>
      <ol className="mt-2 space-y-1.5">
        {bundle.members.map((member, index) => (
          <BundleMemberRow key={member.approvalId} member={member} index={index} current={current} />
        ))}
      </ol>
      <p className="mt-2 text-[12px] leading-[18px] text-muted">
        Audience checks use current membership; bundled changes are not simulated.
      </p>
    </section>
  );
}

function BundleMemberRow({
  member,
  index,
  current,
}: {
  member: NonNullable<Detail['bundle']>['members'][number];
  index: number;
  current: Detail;
}) {
  const isCurrent = member.approvalId === current.id;
  // One exact read per member per open review; the open member's read is already the drawer's.
  const detail = useKeyedApi(member.approvalId, () => api.call('approvals.get', { approvalId: member.approvalId }), { skip: isCurrent });
  const a = isCurrent ? current : detail.data;
  const stale = !!a && a.artifactLatestVersion > a.version;
  const summary = a ? bundleMemberSummary(a, (iso) => formatDateTime(iso, { zone: true })) : null;
  return (
    <li className="rounded-md border border-line px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-5">
        <span className="text-[12px] text-muted">{index + 1}.</span>
        <Link
          to={`/approvals/${member.approvalId}`}
          aria-current={isCurrent ? 'true' : undefined}
          className="font-medium text-fg hover:underline"
        >
          {member.artifactName}
        </Link>
        <span className="text-[12px] text-muted">
          · {typeLabel(member.artifactType)} · Saved v{member.version}
        </span>
        {a &&
          (a.publishedVersion != null ? (
            <StatusPill tone="good">Live v{a.publishedVersion}</StatusPill>
          ) : (
            <StatusPill tone="neutral">Nothing live yet</StatusPill>
          ))}
        {stale && <StatusPill tone="warn">Newer draft v{a.artifactLatestVersion}</StatusPill>}
        {isCurrent && <StatusPill tone="info">This review</StatusPill>}
      </div>
      {summary && (
        <dl className="mt-1.5 grid gap-x-3 gap-y-0.5 text-[12px] leading-[18px] sm:grid-cols-[84px_minmax(0,1fr)]">
          <dt className="text-muted">Publishes</dt>
          <dd className="min-w-0 text-fg-2">
            {summary.publishes} <span className="text-muted">· {summary.live}</span>
          </dd>
          <dt className="text-muted">When</dt>
          <dd className="min-w-0 text-fg-2">{summary.when}</dd>
          {summary.audience && (
            <>
              <dt className="text-muted">Audience</dt>
              <dd className="min-w-0 break-words text-fg-2">{summary.audience}</dd>
            </>
          )}
          {summary.consent && (
            <>
              <dt className="text-muted">Consent</dt>
              <dd className="min-w-0 break-words text-fg-2">{summary.consent}</dd>
            </>
          )}
          {summary.effect && <dd className="text-muted sm:col-span-2">{summary.effect}</dd>}
        </dl>
      )}
      {!isCurrent && detail.error && (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-bad">
          Member summary unavailable.
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={detail.reload}>
            Retry
          </Button>
        </p>
      )}
      {!isCurrent && !a && !detail.error && <p className="mt-1 text-[12px] text-muted">Loading member summary…</p>}
    </li>
  );
}

function History({ a }: { a: Detail }) {
  return (
    <Meta
      items={[
        ['Requested', `${formatDateTime(a.createdAt, { zone: true })} by ${a.requester.displayName}`],
        ...a.history.map((h): [string, React.ReactNode] => [
          h.status === 'approved' ? 'Approved' : 'Rejected',
          <>
            {formatDateTime(h.at, { zone: true })} by {h.by.name}
            {h.note && <span className="mt-0.5 block text-fg-2">“{h.note}”</span>}
          </>,
        ]),
        ['Live version', a.publishedVersion ? `v${a.publishedVersion}` : 'None yet'],
        ['Latest version', `v${a.artifactLatestVersion}`],
      ]}
    />
  );
}
