import { Copy, MoreHorizontal, Pencil, Send, Undo2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, errText, type Out } from '../../app/api';
import { typeLabel } from '../../app/artifactRoutes';
import { ButtonLink } from '../../app/links';
import { type Crumb, useCrumbs } from '../../app/page';
import { addNavigationGuard } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, Field, fieldErrors, Input, LoadingBlock, Menu, Modal, PageHeader, StatePill, StatusPill, Tabs, Textarea, timeAgo, useToast } from '../../ui';
import { invalidateArtifact } from '../artifactCache';
import { withLayout } from '../journey/layout';
import type { JNode } from '../journey/model';
import { ArtifactPreview } from '../previews/ArtifactPreview';
import { ActivityPanel } from './ActivityPanel';
import { JsonEditor } from './JsonEditor';
import { VersionsPanel } from './VersionsPanel';

export type Artifact = Out<'artifacts.get'>;
export type DraftWarning = { nodeId: string | null; path: string; message: string };

export interface EditorProps<C = any> {
  artifact: Artifact;
  content: C;
  onChange: (c: C) => void;
  readOnly: boolean;
  /** Field errors from the last save, keyed by dotted path (e.g. "nodes.2.config.template"). */
  errors: Record<string, string>;
  /** Settings to fill in before publishing (draft warnings). */
  warnings: DraftWarning[];
}

type Tab = string;

/**
 * The detail page every artifact gets (Part 4): content (editable for roles that may), preview,
 * versions with diffs and authors, activity, state, and the publish action the policy allows.
 */
export function ArtifactDetailPage({
  id,
  crumbs,
  editor,
  preview = true,
  description,
  wide,
  extraActions,
  autosave,
  extraTabs = [],
}: {
  id: string;
  /** Breadcrumbs before the artifact's name, e.g. [{label:'Journeys', to:'/build/journeys'}]. */
  crumbs: Crumb[];
  editor?: (p: EditorProps) => ReactNode;
  preview?: boolean;
  description?: ReactNode;
  /** The editor takes the full width (journey canvas). */
  wide?: boolean;
  extraActions?: (a: Artifact) => ReactNode;
  /** Save drafts automatically a moment after each change (journey builder). */
  autosave?: boolean;
  /** Type-specific tabs after Preview, e.g. a broadcast's sending status or a prompt's tests. */
  extraTabs?: { key: string; label: string; render: (a: Artifact) => ReactNode }[];
}) {
  const { can, workspace } = useWorkspace();
  const toast = useToast();
  const art = useApi(() => api.call('artifacts.get', { artifactId: id }), [id]);
  const pendingReq = useApi(() => api.call('approvals.list', { status: 'pending', artifactId: id, limit: 5 }), [id]);
  const a = art.data;
  useCrumbs([...crumbs, { label: a?.name ?? '…' }]);

  const [tab, setTab] = useState<Tab>('content');
  const [draft, setDraft] = useState<unknown>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<DraftWarning[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [lastSave, setLastSave] = useState<'content' | 'layout' | null>(null);

  // Journeys show the saved layout on top of the version's own positions, so moving a step counts
  // as an unsaved change until it is saved, without pretending the version content changed.
  const savedContent = useMemo(
    () =>
      a?.type === 'journey'
        ? withLayout(a.version.content as { nodes?: JNode[] } & Record<string, unknown>, a.layout?.positions)
        : a?.version.content,
    [a],
  );
  useEffect(() => {
    if (savedContent !== undefined) setDraft(savedContent);
  }, [savedContent]);
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(savedContent);
  const readOnly = !can('artifacts:write');

  useEffect(() => {
    if (!dirty) return;
    const off = addNavigationGuard(() => window.confirm('You have unsaved changes. Leave without saving?'));
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      off();
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty]);

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const failedDraft = useRef<string | null>(null);
  const save = useCallback(
    async (opts: { name?: string; quiet?: boolean } = {}) => {
      if (!a) return false;
      setSaving(true);
      setSaveError(null);
      setErrors({});
      try {
        const r = await api.call('artifacts.updateDraft', { artifactId: a.id, content: draft, expectedContentHash: a.version.contentHash, ...(opts.name ? { name: opts.name } : {}) });
        setWarnings(r.warnings);
        setLastSave(r.layoutOnly ? 'layout' : 'content');
        invalidateArtifact(a.id);
        await art.reload();
        setSavedAt(Date.now());
        if (!opts.quiet || r.version !== a.version.number) {
          if (r.layoutOnly) toast.success('Layout saved.');
          else toast.success(r.version === a.version.number ? 'Draft saved.' : `Saved as draft v${r.version}. The live version is unchanged until it is published.`);
        }
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'invalid_input') setErrors(fieldErrors(e.details));
        setConflict(e instanceof ApiError && e.status === 412);
        setSaveError(e instanceof ApiError && e.status === 412 ? `${e.message} Your changes are still here; copy them before reloading.` : errText(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [a, draft, art, toast],
  );

  // Autosave: a moment after the last change; retried on the next change after an error, but never
  // over someone else's newer version (412), where the person decides.
  useEffect(() => {
    if (!autosave || !dirty || readOnly || saving || conflict) return;
    const snapshot = JSON.stringify(draft);
    if (failedDraft.current === snapshot) return;
    const t = setTimeout(async () => {
      if (!(await save({ quiet: true }))) failedDraft.current = snapshot;
    }, 1200);
    return () => clearTimeout(t);
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the draft
  }, [autosave, dirty, readOnly, saving, conflict, draft]);

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey) && dirty && !readOnly) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, readOnly, save]);

  if (art.loading) return <LoadingBlock lines={8} />;
  if (art.error || !a)
    return (
      <Alert tone="bad" title="Couldn't open this item" onRetry={art.reload}>
        {art.error}
      </Alert>
    );

  const latest = a.version;
  const pending = pendingReq.data?.approvals[0];
  const directPublish = workspace.approvalPolicy === 'none' || (workspace.approvalPolicy === 'agent_changes' && latest.author.type === 'user');
  const canPublish = can('artifacts:publish') && latest.state === 'draft' && !dirty;

  const discardDraft = async () => {
    setDiscarding(true);
    setDiscardError(null);
    try {
      const r = await api.call('artifacts.discardDraft', { artifactId: a.id });
      toast.success(`Discarded the draft. Back on live v${r.version}.`);
      setDiscardOpen(false);
      setWarnings([]);
      setSavedAt(null);
      setLastSave(null);
      invalidateArtifact(a.id);
      await art.reload();
    } catch (e) {
      setDiscardError(errText(e));
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={a.name}
        meta={
          <>
            <span>{typeLabel(a.type)}</span>
            {latest.state !== 'published' && <StatePill state={latest.state} />}
            {a.publishedVersion ? <StatusPill tone="good">Live v{a.publishedVersion}</StatusPill> : <StatusPill>Not live</StatusPill>}
            <span>
              v{latest.number} by {latest.by?.displayName ?? (latest.author.type === 'agent' ? 'an agent' : 'a person')} · {timeAgo(latest.createdAt)}
            </span>
          </>
        }
        description={description}
        actions={
          <>
            {extraActions?.(a)}
            {autosave && !readOnly && (
              <span className="text-[12px] text-muted" aria-live="polite">
                {saving
                  ? 'Saving…'
                  : saveError
                    ? 'Not saved, see below'
                    : dirty
                      ? 'Unsaved changes'
                      : lastSave === 'layout'
                        ? 'Layout saved'
                        : savedAt
                          ? 'All changes saved'
                          : 'Changes save automatically'}
              </span>
            )}
            {dirty && !readOnly && (!autosave || conflict) && (
              <>
                <Button variant="ghost" onClick={() => setDraft(savedContent)}>
                  Discard changes
                </Button>
                <Button variant="primary" loading={saving} onClick={() => void save()}>
                  Save draft
                </Button>
              </>
            )}
            {!dirty && pending && (
              <ButtonLink to={`/approvals/${pending.id}`} variant={can('artifacts:approve') ? 'primary' : 'secondary'}>
                {can('artifacts:approve') ? 'Review the request' : 'View the approval request'}
              </ButtonLink>
            )}
            {canPublish && (
              <Button variant="primary" icon={<Send size={14} />} onClick={() => setPublishing(true)}>
                {directPublish ? 'Publish' : 'Submit for review'}
              </Button>
            )}
            <Menu
              label="More actions"
              items={[
                ...(readOnly ? [] : [{ label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(true) }]),
                ...(a.publishedVersion && a.latestVersion > a.publishedVersion && !readOnly
                  ? [
                      {
                        label: `Discard draft (back to live v${a.publishedVersion})`,
                        icon: <Undo2 />,
                        destructive: true,
                        onSelect: () => {
                          setDiscardError(null);
                          setDiscardOpen(true);
                        },
                      },
                    ]
                  : []),
                { label: 'Copy id', icon: <Copy />, hint: a.id.slice(0, 8), onSelect: () => void navigator.clipboard?.writeText(a.id) },
              ]}
              trigger={(p) => (
                <button {...p} type="button" aria-label="More actions" className="inline-flex size-8 items-center justify-center rounded-md border border-line-strong bg-surface text-fg-2 hover:bg-surface-2">
                  <MoreHorizontal size={16} />
                </button>
              )}
            />
          </>
        }
      />
      {latest.state === 'rejected' && <RejectedNote id={a.id} />}
      {saveError && (
        <Alert tone="bad" title="Not saved" className="mb-4">
          {saveError}
        </Alert>
      )}
      {warnings.length > 0 && !dirty && (
        <Alert tone="warn" title="Fill these in before publishing" className="mb-4">
          <ul className="list-disc pl-4">
            {warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Tabs
        label="Sections"
        value={tab}
        onChange={(t) => setTab(t)}
        items={[
          { key: 'content', label: dirty ? 'Content •' : 'Content' },
          ...(preview ? [{ key: 'preview', label: 'Preview' }] : []),
          ...extraTabs.map((t) => ({ key: t.key, label: t.label })),
          { key: 'versions', label: 'Versions', count: a.latestVersion },
          { key: 'activity', label: 'Activity' },
        ]}
      >
        {tab === 'content' &&
          draft !== undefined &&
          (editor ? (
            editor({ artifact: a, content: draft, onChange: setDraft, readOnly, errors, warnings })
          ) : (
            <div className={wide ? '' : 'max-w-[900px]'}>
              <JsonEditor value={draft} onChange={setDraft} readOnly={readOnly} />
            </div>
          ))}
        {tab === 'preview' && (
          <div className="max-w-[1100px] space-y-3">
            {dirty && <Alert tone="info">The preview shows the saved version {latest.number}. Save to preview your changes.</Alert>}
            <ArtifactPreview type={a.type} artifactId={a.id} version={latest.number} content={latest.content} />
          </div>
        )}
        {extraTabs.map((t) => tab === t.key && <div key={t.key}>{t.render(a)}</div>)}
        {tab === 'versions' && <VersionsPanel artifact={a} />}
        {tab === 'activity' && <ActivityPanel artifactId={a.id} />}
      </Tabs>
      {publishing && (
        <PublishDialog
          artifact={a}
          direct={directPublish}
          onClose={() => setPublishing(false)}
          onDone={() => {
            invalidateArtifact(a.id);
            void art.reload();
            void pendingReq.reload();
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          name={a.name}
          onClose={() => setRenaming(false)}
          onRename={async (name) => {
            const ok = await save({ name });
            if (ok) setRenaming(false);
          }}
        />
      )}
      {discardOpen && a.publishedVersion && (
        <Modal
          open
          onClose={() => !discarding && setDiscardOpen(false)}
          title={`Discard the draft and go back to live v${a.publishedVersion}?`}
          footer={
            <>
              <Button onClick={() => setDiscardOpen(false)} disabled={discarding}>
                Keep the draft
              </Button>
              <Button variant="danger" loading={discarding} onClick={() => void discardDraft()}>
                Discard draft
              </Button>
            </>
          }
        >
          <p>
            {a.latestVersion === a.publishedVersion + 1
              ? `Version v${a.latestVersion} is deleted.`
              : `Versions v${a.publishedVersion + 1}–v${a.latestVersion} are deleted.`}{' '}
            The artifact goes back to v{a.publishedVersion}, the version recipients use now.
          </p>
          {discardError && (
            <Alert tone="bad" className="mt-3">
              {discardError}
            </Alert>
          )}
        </Modal>
      )}
    </div>
  );
}

function RejectedNote({ id }: { id: string }) {
  const r = useApi(() => api.call('approvals.list', { status: 'rejected', artifactId: id, limit: 1 }), [id]);
  const last = r.data?.approvals.at(-1);
  if (!last) return null;
  return (
    <Alert tone="bad" title="Rejected" className="mb-4">
      {last.decisionNote ? `“${last.decisionNote}”` : 'No reason given.'} Edit the content and submit it again.
    </Alert>
  );
}

function PublishDialog({ artifact, direct, onClose, onDone }: { artifact: Artifact; direct: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!note.trim()) return setNoteError('Say what changed, for the reviewer and the history.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('artifacts.requestPublish', { artifactId: artifact.id, note: note.trim() });
      if (r.status === 'published') toast.success(`Published v${r.version}. It is live now.`);
      else toast.success(`Submitted v${r.version} for review. A person with approval rights decides.`);
      onDone();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={direct ? `Publish “${artifact.name}”?` : `Submit “${artifact.name}” for review?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {direct ? `Publish v${artifact.version.number}` : 'Submit for review'}
          </Button>
        </>
      }
    >
      <p className="mb-3">
        {direct
          ? 'Version ' + artifact.version.number + ' goes live at once under your workspace approval policy.'
          : 'A person with approval rights reviews version ' + artifact.version.number + ' and approves or rejects it. Nothing changes for recipients until then.'}
      </p>
      <Field label="What changed?" hint="Shown to the reviewer and kept in the version history." error={noteError} required>
        <Textarea
          rows={3}
          value={note}
          data-autofocus
          maxLength={1000}
          onChange={(e) => {
            setNote(e.target.value);
            setNoteError(null);
          }}
        />
      </Field>
      {error && (
        <Alert tone="bad" className="mt-3">
          {error}
        </Alert>
      )}
    </Modal>
  );
}

function RenameDialog({ name, onClose, onRename }: { name: string; onClose: () => void; onRename: (n: string) => Promise<void> }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const valid = value.trim().length > 0 && value.trim() !== name;
  return (
    <Modal
      open
      onClose={onClose}
      title="Rename"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onRename(value.trim());
              setBusy(false);
            }}
          >
            Rename
          </Button>
        </>
      }
    >
      <Field label="Name" hint="Renaming saves the current content as a draft too.">
        <Input value={value} onChange={(e) => setValue(e.target.value)} data-autofocus maxLength={120} />
      </Field>
    </Modal>
  );
}

export function useArtifactContent<C>(content: unknown) {
  return useMemo(() => content as C, [content]);
}
