import { Check, CheckCheck, Eye, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { typeLabel } from '../../app/artifactRoutes';
import { useCrumbs } from '../../app/page';
import { Link, navigate, useLocation } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { approvalDecisions } from '../../features/approvals/decisions';
import { HoldBadge, HoldCountdown } from '../../features/approvals/HoldBadge';
import { useNow } from '../../features/approvals/holds';
import { RequesterView } from '../../features/approvals/requester';
import { decisionWasViewed, useViewedTick } from '../../features/approvals/viewed';
import {
  Alert,
  Button,
  Checkbox,
  cx,
  EmptyState,
  Field,
  LoadingBlock,
  PageHeader,
  StatusPill,
  Table,
  TableFrame,
  Tabs,
  Tag,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
  timeAgo,
  useConfirm,
  useToast,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

type Approval = Out<'approvals.list'>['approvals'][number];
type Proposal = Out<'workspace.proposals'>['proposals'][number];
type Status = 'pending' | 'approved' | 'rejected';

// The route table keys each page by path (routes.tsx), so opening /approvals/:id remounts this
// page. The invoking row therefore has to be remembered outside the component instance; a deep
// link has never set it and falls back to the queue heading.
let lastApprovalInvokerId: string | null = null;
let returnFocusPending = false;
let returnFocusApprovalId: string | null = null;
let approvalsPageSeq = 0;

const FOCUS_RETURN_LIMIT_MS = 10_000;
const FOCUS_RETURN_POLL_MS = 50;
// Every timer the pending restoration owns. Navigation or unmount clears them, so a late retry
// can never steal focus after the person has moved on (#498 review).
const returnFocusTimers = new Set<ReturnType<typeof setTimeout>>();
let returnFocusIntentExpiry: ReturnType<typeof setTimeout> | null = null;

function scheduleReturnFocus(fn: () => void, delay: number) {
  const timer = setTimeout(() => {
    returnFocusTimers.delete(timer);
    fn();
  }, delay);
  returnFocusTimers.add(timer);
  return timer;
}

/** Cancel every timer belonging to a pending focus restoration. */
export function cancelApprovalFocusReturn() {
  for (const timer of returnFocusTimers) clearTimeout(timer);
  returnFocusTimers.clear();
}

/** Forget the restoration intent too, e.g. when the person navigated away from Approvals. */
function clearReturnFocusIntent() {
  returnFocusPending = false;
  returnFocusApprovalId = null;
  if (returnFocusIntentExpiry) {
    clearTimeout(returnFocusIntentExpiry);
    returnFocusIntentExpiry = null;
  }
}

/**
 * An unmount can be the route remount that finishes a normal drawer close. Keep the intent for a
 * task so the next Approvals instance can consume it, then drop it if nobody did.
 */
function expireReturnFocusIntent() {
  if (returnFocusIntentExpiry) clearTimeout(returnFocusIntentExpiry);
  returnFocusIntentExpiry = setTimeout(() => {
    returnFocusIntentExpiry = null;
    clearReturnFocusIntent();
  }, 0);
}

/** Forget every pending restoration. Tests also use this to isolate cases. */
export function resetApprovalFocusReturn() {
  cancelApprovalFocusReturn();
  clearReturnFocusIntent();
}

/** Focus already belongs to a person's chosen control, not the body or the closing drawer. */
function focusMovedByUser() {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || active === document.documentElement) return false;
  // While the drawer is still in the DOM its trap/remnant is not a deliberate destination.
  return !active.closest('[role="dialog"]');
}

/** Focus the invoking row in the mounted queue, waiting while its list reloads after a remount. */
export function focusApprovalReturn(id: string | null, fromPageId: number, force = false) {
  cancelApprovalFocusReturn();
  const started = Date.now();
  let finished = false;
  const stop = () => {
    finished = true;
    cancelApprovalFocusReturn();
  };
  // The drawer's focus trap restores its previous focus in a passive effect during unmount,
  // which can land after this task; re-assert once so the return focus is the last word.
  const keepFocus = (element: HTMLElement | undefined) => {
    if (!element) return;
    element.focus();
    scheduleReturnFocus(() => {
      // Only undo a trap restoring focus to the body or a drawer remnant; never steal focus from a
      // person who has already moved on to another control.
      if (element.isConnected && !focusMovedByUser()) element.focus();
    }, 150);
  };
  const attempt = () => {
    if (finished) return;
    // A person who moved focus somewhere meaningful is not asking for a restoration.
    if (focusMovedByUser()) {
      returnFocusApprovalId = null;
      stop();
      return;
    }
    const elapsed = Date.now() - started;
    const roots = [...document.querySelectorAll<HTMLElement>('[data-approvals-page]')];
    // The closing route remounts the page; prefer the newly mounted instance. A direct render
    // (tests) never remounts, so accept the existing root after a short grace period.
    const root = force
      ? roots[roots.length - 1]
      : (roots.find((candidate) => candidate.dataset.approvalsPage !== String(fromPageId)) ?? (elapsed >= 200 ? roots[0] : undefined));
    if (!root) {
      // No queue to focus: give up at the same limit as every other retry path.
      if (elapsed >= FOCUS_RETURN_LIMIT_MS) {
        returnFocusApprovalId = null;
        stop();
        return;
      }
      scheduleReturnFocus(attempt, FOCUS_RETURN_POLL_MS);
      return;
    }
    const loading = !!root.querySelector('[role="status"][aria-label="Loading"]');
    const links = id ? [...root.querySelectorAll<HTMLAnchorElement>(`a[data-approval-link="${id}"]`)] : [];
    // Both responsive copies exist; only the one with a layout box is focusable. jsdom has no
    // layout, so fall back to the first and let the DOM report whether focus moved.
    const laidOut = links.filter((link) => link.offsetParent !== null);
    const target = (laidOut.length ? laidOut : links)[0];
    if (target) {
      keepFocus(target);
      returnFocusApprovalId = null;
      finished = true;
      return;
    }
    // The queue reloads on remount; wait for it rather than focusing the heading too early.
    if (id && (loading || elapsed < 250) && elapsed < FOCUS_RETURN_LIMIT_MS) {
      scheduleReturnFocus(attempt, FOCUS_RETURN_POLL_MS);
      return;
    }
    keepFocus(root.querySelector<HTMLElement>('[data-approvals-heading]') ?? undefined);
    returnFocusApprovalId = null;
    finished = true;
  };
  // The drawer's focus trap restores focus in a passive effect during unmount; a task boundary
  // lets that cleanup finish so the return focus is the last word.
  scheduleReturnFocus(attempt, 30);
}

// The review drawer and its consequence reads are only needed once a request is opened; keeping
// them out of the queue's chunk leaves the list light (#60, #498).
const ApprovalDrawer = lazy(() => import('../../features/approvals/ApprovalDrawer').then((m) => ({ default: m.ApprovalDrawer })));

/** Approvals (#41): the queue of changes waiting for a person, each opened in a review drawer. */
export default function ApprovalsPage({ params }: { params: Record<string, string> }) {
  useCrumbs([{ label: 'Approvals', to: '/approvals' }, ...(params.id ? [{ label: 'Review' }] : [])]);
  const { can, user, refreshPending } = useSession();
  const { search } = useLocation();
  const status = (search.get('status') as Status) || 'pending';
  const list = useApi(() => api.call('approvals.list', { status, limit: 200 }), [status]);
  const proposals = useApi(() => api.call('workspace.proposals', { status: 'pending', limit: 50 }), []);
  const highlightedProposal = search.get('proposal');
  useEffect(() => {
    if (!highlightedProposal || !proposals.data) return;
    document.getElementById(`proposal-${highlightedProposal}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightedProposal, proposals.data]);
  const toast = useToast();
  const [pageId] = useState(() => ++approvalsPageSeq);
  const closeFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A row-opened drawer returns focus to that row's link; a deep link has no invoking row and
  // falls back to the queue heading (#498 review). The route remounts this page, so a closing
  // drawer leaves the intent for whichever instance mounts next as well as trying immediately.
  useEffect(() => {
    if (!returnFocusPending) return;
    returnFocusPending = false;
    if (returnFocusIntentExpiry) {
      clearTimeout(returnFocusIntentExpiry);
      returnFocusIntentExpiry = null;
    }
    focusApprovalReturn(returnFocusApprovalId, pageId, true);
  }, [pageId]);
  // Leaving the page cancels any pending restoration. A remount to another /approvals route keeps
  // the intent for one task, so the normal drawer close can still return focus.
  useEffect(
    () => () => {
      if (closeFallbackTimer.current) {
        clearTimeout(closeFallbackTimer.current);
        closeFallbackTimer.current = null;
      }
      cancelApprovalFocusReturn();
      if (window.location.pathname.replace(/\/+$/, '').startsWith('/approvals')) expireReturnFocusIntent();
      else clearReturnFocusIntent();
    },
    [],
  );
  const openApproval = (id: string) => {
    lastApprovalInvokerId = id;
    navigate(`/approvals/${id}${status === 'pending' ? '' : `?status=${status}`}`);
  };
  const closeApproval = () => {
    returnFocusApprovalId = lastApprovalInvokerId;
    returnFocusPending = true;
    lastApprovalInvokerId = null;
    navigate(status === 'pending' ? '/approvals' : `/approvals?status=${status}`);
    // A remount handles the return focus; when the page does not remount (a directly rendered
    // queue), retry in this instance after the drawer has finished unmounting.
    if (closeFallbackTimer.current) clearTimeout(closeFallbackTimer.current);
    closeFallbackTimer.current = setTimeout(() => {
      closeFallbackTimer.current = null;
      if (!returnFocusPending) return;
      returnFocusPending = false;
      focusApprovalReturn(returnFocusApprovalId, pageId, true);
    }, 400);
  };
  const [confirmDialog, confirm] = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batching, setBatching] = useState(false);
  const now = useNow();
  useViewedTick();

  const all = list.data?.approvals ?? [];
  // A bundle (#107) is one decision, so it is one row: the member the others exist for (the
  // broadcast, the form) stands for it, and counts as viewed once every member's preview was opened.
  // The nav badge uses the same grouping (#483).
  const items = approvalDecisions(all);
  const canApprove = can('artifacts:approve');
  const viewed = (a: Approval) => decisionWasViewed(user!.id, a);
  const selectable = items.filter((a) => a.status === 'pending' && viewed(a));
  const chosen = items.filter((a) => selected.has(a.id) && viewed(a));
  const notViewed = items.filter((a) => a.status === 'pending' && !viewed(a)).length;

  const reload = () => {
    void list.reload();
    void proposals.reload();
    refreshPending();
  };
  const batchApprove = async () => {
    const ok = await confirm({
      title: `Approve ${chosen.length} ${chosen.length === 1 ? 'change' : 'changes'}?`,
      body: (
        <>
          <p>Each one is published at once:</p>
          <ul className="mt-2 list-disc pl-5">
            {chosen.flatMap((a) =>
              (a.bundle?.members ?? [a]).map((m) => (
                <li key={'approvalId' in m ? m.approvalId : m.id}>
                  {m.artifactName}{' '}
                  <span className="text-muted">
                    ({typeLabel(m.artifactType)}, v{m.version})
                  </span>
                </li>
              )),
            )}
          </ul>
        </>
      ),
      confirmLabel: `Approve ${chosen.length}`,
    });
    if (!ok) return;
    setBatching(true);
    const failed: string[] = [];
    for (const a of chosen) {
      try {
        await api.call('approvals.approve', { approvalId: a.id });
      } catch (e) {
        failed.push(`${a.artifactName}: ${(e as Error).message}`);
      }
    }
    setBatching(false);
    setSelected(new Set());
    if (failed.length)
      toast.error(
        <>
          Some approvals failed:
          <br />
          {failed.join('; ')}
        </>,
      );
    else toast.success(`Approved ${chosen.length} ${chosen.length === 1 ? 'change' : 'changes'}; they are live.`);
    reload();
  };

  const tabs = useMemo(
    () => [
      { key: 'pending' as const, label: 'Pending', count: status === 'pending' ? items.length : undefined },
      { key: 'approved' as const, label: 'Approved' },
      { key: 'rejected' as const, label: 'Rejected' },
    ],
    [status, items.length],
  );

  return (
    <div className={pageWidth('default')} data-approvals-page={pageId}>
      <PageHeader
        title={
          // The fallback focus target when a deep-linked drawer closes (there is no invoking row).
          <span data-approvals-heading tabIndex={-1} className="outline-none">
            Approvals
          </span>
        }
        description="Changes waiting for a person. Open each one to see the actual e-mail, form, journey, segment or broadcast before you approve it."
        actions={
          canApprove && status === 'pending' && items.length > 0 ? (
            <Button variant="primary" icon={<CheckCheck size={15} />} disabled={!chosen.length} loading={batching} onClick={batchApprove}>
              {chosen.length ? `Approve ${chosen.length} selected` : 'Approve selected'}
            </Button>
          ) : undefined
        }
      />
      <Tabs
        label="Status"
        items={tabs}
        value={status}
        onChange={(k) => navigate(k === 'pending' ? '/approvals' : `/approvals?status=${k}`, { replace: true })}
      />
      {status === 'pending' && (
        <WorkspaceSettings
          proposals={proposals.data?.proposals ?? []}
          canApprove={can('workspace:admin')}
          highlighted={highlightedProposal}
          onDecided={reload}
        />
      )}
      {canApprove && status === 'pending' && notViewed > 0 && items.length > 1 && (
        <p className="mt-3 text-[12px] text-muted">
          <Eye size={13} className="mr-1 inline align-[-2px]" aria-hidden />
          You can select a change for batch approval after you have opened its preview. {notViewed} not yet viewed.
        </p>
      )}
      <div className="mt-4">
        <TableFrame
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          columns={5}
          isEmpty={items.length === 0}
          empty={
            <EmptyState title={status === 'pending' ? 'Nothing waiting for review' : `No ${status} changes`}>
              {status === 'pending'
                ? 'When an agent or a teammate submits a change for review, it appears here. You get the link in their request too.'
                : 'Decisions appear here once someone approves or rejects a change.'}
            </EmptyState>
          }
        >
          {/* Cards on phones, a table from 640 px. */}
          <ul className="divide-y divide-line sm:hidden">
            {items.map((a) => (
              <li key={a.id}>
                <Link
                  to={`/approvals/${a.id}${status === 'pending' ? '' : `?status=${status}`}`}
                  data-approval-link={a.id}
                  className="block px-4 py-3 hover:bg-surface-2"
                  onClick={() => {
                    lastApprovalInvokerId = a.id;
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-fg">
                      {a.artifactName}
                      <BundleNote a={a} />
                    </span>
                    <ViewedPill a={a} viewed={viewed(a)} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <Tag>{typeLabel(a.artifactType)}</Tag>
                    <RequesterView r={a.requester} />
                    <span>{timeAgo(a.createdAt)}</span>
                  </div>
                  {a.note && <p className="mt-1.5 line-clamp-2 text-[13px] text-fg-2">{a.note}</p>}
                  {a.holdUntil && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <HoldBadge />
                      <HoldCountdown holdUntil={a.holdUntil} now={now} />
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <Table label="Approval requests" className="hidden sm:table">
            <THead>
              <tr>
                {canApprove && status === 'pending' && (
                  <Th className="w-10 pr-0">
                    <span className="sr-only">Select</span>
                    <input
                      type="checkbox"
                      aria-label="Select all viewed changes"
                      className="size-4 accent-[var(--accent)]"
                      checked={selectable.length > 0 && selectable.every((a) => selected.has(a.id))}
                      disabled={!selectable.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((a) => a.id)) : new Set())}
                    />
                  </Th>
                )}
                <Th>Change</Th>
                <Th>Requested by</Th>
                <Th className="hidden lg:table-cell">Note</Th>
                <Th>{status === 'pending' ? 'Waiting' : 'Requested'}</Th>
                <Th>{status === 'pending' ? 'Review' : 'Decision'}</Th>
              </tr>
            </THead>
            <tbody>
              {items.map((a) => (
                <Tr key={a.id} onClick={() => openApproval(a.id)} selected={params.id === a.id}>
                  {canApprove && status === 'pending' && (
                    <Td className="pr-0" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        label={<span className="sr-only">Select {a.artifactName}</span>}
                        checked={selected.has(a.id)}
                        disabled={!viewed(a)}
                        title={viewed(a) ? undefined : 'Open the preview first'}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(a.id);
                          else next.delete(a.id);
                          setSelected(next);
                        }}
                      />
                    </Td>
                  )}
                  <Td>
                    <Link
                      to={`/approvals/${a.id}${status === 'pending' ? '' : `?status=${status}`}`}
                      data-approval-link={a.id}
                      className="font-medium text-fg hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        lastApprovalInvokerId = a.id;
                      }}
                    >
                      {a.artifactName}
                    </Link>
                    <BundleNote a={a} />
                    <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
                      {typeLabel(a.artifactType)} · v{a.version} ·{' '}
                      {a.artifactPublishedVersion ? `changes live v${a.artifactPublishedVersion}` : 'new'}
                    </div>
                  </Td>
                  <Td>
                    <RequesterView r={a.requester} />
                  </Td>
                  <Td className="hidden max-w-[320px] lg:table-cell">
                    <span className="line-clamp-2">{a.note}</span>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <div>{timeAgo(a.createdAt)}</div>
                    {a.holdUntil && (
                      <div className="mt-1 space-y-1">
                        <HoldBadge />
                        <div>
                          <HoldCountdown holdUntil={a.holdUntil} now={now} />
                        </div>
                      </div>
                    )}
                  </Td>
                  <Td>
                    {a.status === 'pending' ? (
                      <ViewedPill a={a} viewed={viewed(a)} />
                    ) : (
                      <StatusPill tone={a.status === 'approved' ? 'good' : 'bad'}>
                        {a.status === 'approved' ? 'Approved' : 'Rejected'}
                      </StatusPill>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </div>
      {confirmDialog}
      {params.id && (
        <Suspense fallback={<LoadingBlock lines={6} label="Opening the review" />}>
          <ApprovalDrawer
            id={params.id}
            queue={items.filter((a) => a.status === 'pending').map((a) => a.id)}
            onClose={closeApproval}
            onDecided={reload}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * Pending workspace setting proposals (#106). They are not artifacts, so they sit above the
 * queue as a small card: the diff, why, and Approve / Reject for admins.
 */
function WorkspaceSettings({
  proposals,
  canApprove,
  highlighted,
  onDecided,
}: {
  proposals: Proposal[];
  canApprove: boolean;
  highlighted: string | null;
  onDecided: () => void;
}) {
  const toast = useToast();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!proposals.length) return null;

  const approve = async (p: Proposal) => {
    setBusy(p.id);
    setError(null);
    try {
      await api.call('workspace.approveProposal', { proposalId: p.id });
      toast.success('Approved the workspace settings change; it is live.');
      onDecided();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = async (p: Proposal) => {
    if (!reason.trim()) {
      setReasonError('Say what to change, so the requester can try again.');
      return;
    }
    setBusy(p.id);
    setError(null);
    try {
      await api.call('workspace.rejectProposal', { proposalId: p.id, note: reason.trim() });
      toast.success('Rejected the workspace settings change. The requester sees your reason.');
      setRejecting(null);
      setReason('');
      onDecided();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Workspace settings" className="mt-4 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[14px] font-semibold text-fg">Workspace settings</h2>
        <span className="text-[12px] text-muted">Proposed changes that need a person.</span>
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="bad">{error}</Alert>
        </div>
      )}
      <ul className="mt-2 divide-y divide-line">
        {proposals.map((p) => (
          <li
            key={p.id}
            id={`proposal-${p.id}`}
            className={cx('py-3 first:pt-0 last:pb-0', highlighted === p.id && 'rounded-md bg-surface-2 px-2 ring-2 ring-[var(--accent)]')}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
              <RequesterView r={p.requester} />
              <span>proposed {timeAgo(p.createdAt)}</span>
            </div>
            <p className="mt-1.5 text-[13px] text-fg-2">
              <strong className="font-medium text-fg">If approved:</strong> Applies workspace settings immediately on approval.
            </p>
            <ul className="mt-1 space-y-0.5 text-[14px] text-fg">
              {p.changes.name && (
                <li>
                  Name: <span className="text-muted">{p.changes.name.from}</span> → <span className="font-medium">{p.changes.name.to}</span>
                </li>
              )}
              {p.changes.timeZone && (
                <li>
                  Time zone: <span className="text-muted">{p.changes.timeZone.from}</span> →{' '}
                  <span className="font-medium">{p.changes.timeZone.to}</span>
                </li>
              )}
            </ul>
            {p.changes.timeZone && (
              <p className="mt-1 text-[12px] text-muted">Changes display time zone; stored send instants stay the same.</p>
            )}
            <p className="mt-1.5 text-[13px] whitespace-pre-wrap text-fg-2">{p.note}</p>
            {canApprove ? (
              rejecting === p.id ? (
                <div className="mt-2 space-y-2">
                  <Field
                    label="Why are you rejecting it?"
                    hint="The requester sees this and can propose a different value."
                    error={reasonError}
                    required
                  >
                    <Textarea
                      rows={2}
                      value={reason}
                      autoFocus
                      onChange={(e) => {
                        setReason(e.target.value);
                        setReasonError(null);
                      }}
                      onBlur={() => !reason.trim() && setReasonError('Say what to change, so the requester can try again.')}
                    />
                  </Field>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setRejecting(null);
                        setReason('');
                      }}
                    >
                      Cancel
                    </Button>
                    <Button variant="danger" icon={<X size={14} />} loading={busy === p.id} onClick={() => reject(p)}>
                      Reject with reason
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    icon={<X size={14} />}
                    onClick={() => {
                      setRejecting(p.id);
                      setReason('');
                      setReasonError(null);
                    }}
                  >
                    Reject
                  </Button>
                  <Button variant="primary" icon={<Check size={14} />} loading={busy === p.id} onClick={() => approve(p)}>
                    Approve
                  </Button>
                </div>
              )
            ) : (
              <p className="mt-2 text-[12px] text-muted">An admin decides workspace settings.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ViewedPill({ a, viewed }: { a: Approval; viewed: boolean }) {
  if (a.status !== 'pending') return null;
  return viewed ? (
    <StatusPill tone="neutral" className={cx('bg-transparent')}>
      Viewed
    </StatusPill>
  ) : (
    <StatusPill tone="warn">Not yet viewed</StatusPill>
  );
}

/** "+ 1 reviewed together", naming the other members of a bundle. */
function BundleNote({ a }: { a: Approval }) {
  const others = a.bundle?.members.filter((m) => m.approvalId !== a.id) ?? [];
  if (!others.length) return null;
  return (
    <span
      className="ml-1.5 text-[12px] font-normal text-muted"
      title={others.map((m) => `${m.artifactName} (${typeLabel(m.artifactType)})`).join(', ')}
    >
      + {others.length} reviewed together
    </span>
  );
}
