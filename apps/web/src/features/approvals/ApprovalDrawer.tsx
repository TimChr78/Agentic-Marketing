import { Check, ExternalLink, Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { artifactPath, typeLabel } from '../../app/artifactRoutes';
import { TextLink } from '../../app/links';
import { navigate } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, DiffView, Drawer, Field, JsonView, LoadingBlock, Meta, StatusPill, Tabs, Textarea, formatDateTime, timeAgo, useToast } from '../../ui';
import { invalidateArtifact } from '../artifactCache';
import { ArtifactPreview } from '../previews/ArtifactPreview';
import { RequesterView } from './requester';
import { markViewed } from './viewed';

type Detail = Out<'approvals.get'>;
type Tab = 'preview' | 'changes' | 'content' | 'history';

/**
 * Review drawer (#41): the object itself first (rendered e-mail, form, journey graph, segment
 * size, broadcast audience), then what changed against the live version, who asked and why, and
 * Approve / Reject right here. Deep link: /approvals/<id> (the reviewUrl agents get back).
 */
export function ApprovalDrawer({ id, queue, onClose, onDecided }: { id: string; queue: string[]; onClose: () => void; onDecided: () => void }) {
  const { can, user, workspace } = useWorkspace();
  const toast = useToast();
  const d = useApi(() => api.call('approvals.get', { approvalId: id }), [id]);
  const [tab, setTab] = useState<Tab>('preview');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'test'>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setTab('preview');
    setRejecting(false);
    setReason('');
    setActionError(null);
  }, [id]);
  // Opening the preview is what counts as viewing this version.
  useEffect(() => {
    if (d.data && tab === 'preview') markViewed(user.id, d.data.id, d.data.version);
  }, [d.data, tab, user.id]);

  const a = d.data;
  const pending = a?.status === 'pending';
  const canApprove = can('artifacts:approve');
  const ownRequest = a?.requestedBy.type === 'user' && a.requestedBy.id === user.id;
  // Approvers can test to their own address (the commands accept artifacts:approve without `to`).
  const testable = a && (can('artifacts:write') || can('artifacts:approve')) && (a.artifactType === 'email_template' || (a.artifactType === 'broadcast' && String((a.content as { template?: string }).template ?? '').startsWith('eml_')));

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
      invalidateArtifact(a.artifactId);
      toast.success(kind === 'approve' ? `Approved “${a.artifactName}”. Version ${a.version} is live.` : `Rejected “${a.artifactName}”. The author sees your reason.`);
      onDecided();
      next();
    } catch (e) {
      setActionError(errText(e));
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
          ? await api.call('broadcasts.sendTest', { artifactId: a.artifactId, version: a.version })
          : await api.call('templates.sendTest', { artifactId: a.artifactId, version: a.version });
      toast.success(`Test sent to ${r.to}: “${r.subject}”.`);
    } catch (e) {
      toast.error(`The test was not sent: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const stale = a && a.artifactLatestVersion > a.version;
  return (
    <Drawer
      open
      onClose={onClose}
      width="xl"
      title={a?.artifactName ?? 'Loading…'}
      meta={
        a && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {typeLabel(a.artifactType)} · Version {a.version} · {a.publishedVersion ? `changes live v${a.publishedVersion}` : 'new, nothing live yet'}
            </span>
            {a.status !== 'pending' && <StatusPill tone={a.status === 'approved' ? 'good' : 'bad'}>{a.status === 'approved' ? 'Approved' : a.status === 'rejected' ? 'Rejected' : 'Withdrawn'}</StatusPill>}
          </span>
        )
      }
      actions={a && <TextLink to={artifactPath(a.artifactType, a.artifactId)} className="mr-1 hidden items-center gap-1 text-[13px] sm:inline-flex">Open <ExternalLink size={13} aria-hidden /></TextLink>}
      footer={
        a &&
        pending && (
          <div className="w-full space-y-3">
            {actionError && <Alert tone="bad">{actionError}</Alert>}
            {rejecting && (
              <Field label="Why are you rejecting it?" hint="The author (person or agent) sees this and can submit a fixed version." error={reasonError} required>
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
                  <Button icon={<Send size={14} />} loading={busy === 'test'} onClick={sendTest} title="Send a [Test] copy of this version to your own address">
                    Send me a test
                  </Button>
                )}
                <div className="ml-auto flex flex-wrap gap-2">
                  {rejecting ? (
                    <>
                      <Button variant="ghost" onClick={() => setRejecting(false)}>
                        Cancel
                      </Button>
                      <Button variant="danger" icon={<X size={14} />} loading={busy === 'reject'} onClick={() => decide('reject')}>
                        Reject with reason
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="danger" icon={<X size={14} />} onClick={() => setRejecting(true)}>
                        Reject
                      </Button>
                      <Button variant="primary" icon={<Check size={14} />} loading={busy === 'approve'} onClick={() => decide('approve')}>
                        Approve and publish
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
      {d.loading ? (
        <LoadingBlock lines={8} />
      ) : d.error ? (
        <div className="p-5">
          <Alert tone="bad" title="Couldn't open this approval request" onRetry={d.reload}>
            {d.error}
          </Alert>
        </div>
      ) : a ? (
        <div className="space-y-4 p-5">
          <section aria-label="Request" className="rounded-lg border border-line bg-surface-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <RequesterView r={a.requester} className="font-medium text-fg" />
              <span className="text-muted" title={formatDateTime(a.createdAt, { zone: true })}>
                asked {timeAgo(a.createdAt)}
              </span>
            </div>
            {a.note && <p className="mt-2 text-[14px] leading-[22px] whitespace-pre-wrap text-fg">{a.note}</p>}
          </section>
          {stale && (
            <Alert tone="warn" title={`A newer draft (v${a.artifactLatestVersion}) exists`}>
              Approving publishes version {a.version}, the one shown here. The newer draft stays a draft.
            </Alert>
          )}
          {ownRequest && pending && workspace.approvalPolicy === 'all_publishes' && <Alert tone="info">You submitted this yourself. Under four-eyes review, another person has to approve it.</Alert>}
          <Tabs
            label="Review"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'preview', label: 'Preview' },
              { key: 'changes', label: a.publishedVersion ? 'Changes' : 'Content changes', count: a.diff.changes.length },
              { key: 'content', label: 'Content' },
              { key: 'history', label: 'History' },
            ]}
          >
            {tab === 'preview' && <ArtifactPreview type={a.artifactType} artifactId={a.artifactId} version={a.version} content={a.content} compact />}
            {tab === 'changes' && <DiffView changes={a.diff.changes} from={a.diff.from} to={a.diff.to} />}
            {tab === 'content' && <JsonView value={a.content} label={`Version ${a.version} as JSON (what agents read and write)`} maxHeight={600} />}
            {tab === 'history' && <History a={a} />}
          </Tabs>
        </div>
      ) : null}
    </Drawer>
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
