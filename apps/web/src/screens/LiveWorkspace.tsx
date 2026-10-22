import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, FilePlus2, History, LogIn, RefreshCw, Send, ShieldCheck, XCircle } from 'lucide-react';
import { ApiError } from '@agentic-marketing/client';
import { AuthorBadge, Button, Card, PageHeader, Pill, cx, inputCls, timeAgo } from '../components/ui';
import { LiveProfiles } from './LiveProfiles';
import { LiveEmails } from './live/LiveEmails';
import { LiveExperiences } from './live/LiveExperiences';
import { LiveJourneys } from './live/LiveJourneys';
import { api, errText, type Out } from './liveApi';

// Phase 0: this screen talks to the real API (apps/server) through the typed client. Every
// action is the same command an MCP agent would call, under the same rules.

type Workspace = Out<'workspace.get'>;
type ArtifactList = Out<'artifacts.list'>['artifacts'];
type Artifact = Out<'artifacts.get'>;

const stateTone = { draft: 'neutral', in_review: 'agent', published: 'good', superseded: 'neutral', rejected: 'bad' } as const;

export function LiveWorkspace() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<'loading' | 'signed-out' | 'offline' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'artifacts' | 'journeys' | 'emails' | 'experiences' | 'people'>('artifacts');

  const load = useCallback(async () => {
    try {
      setWs(await api.call('workspace.get', {}));
      setStatus('ready');
    } catch (e) {
      setStatus(e instanceof ApiError && e.status === 401 ? 'signed-out' : 'offline');
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (status === 'loading') return <p className="text-muted">Connecting to the API…</p>;
  if (status === 'offline')
    return (
      <div className="mx-auto max-w-[640px]">
        <PageHeader eyebrow="Phase 0 · real API" title="Live workspace" />
        <Card>
          <div className="space-y-2 p-5 text-[14px]">
            <p>
              This screen needs the API server. Run <code className="font-mono">pnpm dev</code> (API on :3000) and <code className="font-mono">pnpm dev:web</code>, then reload.
            </p>
            <p className="text-muted">The published demo link has no backend, so this screen only works locally.</p>
          </div>
        </Card>
      </div>
    );
  if (status === 'signed-out') return <SignIn onDone={load} />;

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader eyebrow={`Real API · ${ws!.you.role}`} title={ws!.name}>
        <PolicyPicker ws={ws!} onChange={load} onError={setError} />
      </PageHeader>
      {error && (
        <div className="mb-4 rounded-md border border-bad/40 bg-bad-soft px-4 py-2.5 text-[13px] text-bad" role="alert">
          {error}
        </div>
      )}
      <div className="mb-4 flex gap-1 overflow-x-auto" role="tablist">
        {(
          [
            ['artifacts', 'Artifacts & approvals'],
            ['journeys', 'Journeys'],
            ['emails', 'E-mails'],
            ['experiences', 'Web experiences'],
            ['people', 'People & data'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium', tab === key ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2')}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'artifacts' && <Artifacts onError={setError} />}
      {tab === 'journeys' && <LiveJourneys onError={setError} />}
      {tab === 'emails' && <LiveEmails canAdmin={ws!.you.permissions.includes('workspace:admin')} onError={setError} />}
      {tab === 'experiences' && <LiveExperiences onError={setError} />}
      {tab === 'people' && <LiveProfiles canAdmin={ws!.you.permissions.includes('workspace:admin')} onError={setError} />}
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="mx-auto max-w-[420px]">
      <PageHeader eyebrow="Phase 0 · real API" title="Sign in" />
      <Card>
        <form
          className="space-y-3 p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await fetch('/api/auth/sign-in/email', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
            if (r.ok) onDone();
            else setErr((await r.json().catch(() => ({}))).message ?? 'Sign-in failed');
          }}
        >
          <input id="live-email" className={inputCls} type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          <input id="live-password" className={inputCls} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          {err && <p className="text-[13px] text-bad">{err}</p>}
          <Button variant="primary" className="w-full">
            <LogIn size={14} /> Sign in
          </Button>
          <p className="text-[12px] text-muted">
            Create the first owner with <code className="font-mono">pnpm --filter @agentic-marketing/server cli bootstrap</code>.
          </p>
        </form>
      </Card>
    </div>
  );
}

function PolicyPicker({ ws, onChange, onError }: { ws: Workspace; onChange: () => void; onError: (m: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-muted">
      Approval policy
      <select
        id="live-policy"
        className={cx(inputCls, 'w-auto')}
        value={ws.approvalPolicy}
        onChange={async (e) => {
          try {
            await api.call('workspace.setApprovalPolicy', { policy: e.target.value as Workspace['approvalPolicy'] });
            onChange();
          } catch (err) {
            onError(errText(err));
          }
        }}
      >
        <option value="none">No approvals</option>
        <option value="agent_changes">Agent changes need a person</option>
        <option value="all_publishes">Every publish needs someone else</option>
      </select>
    </label>
  );
}

function Artifacts({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<ArtifactList>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Out<'approvals.list'>['approvals']>([]);
  const [audit, setAudit] = useState<Out<'audit.list'>['entries']>([]);
  const [title, setTitle] = useState('');
  const [verified, setVerified] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([api.call('artifacts.list', {}), api.call('approvals.list', {})]);
      setList(a.artifacts);
      setApprovals(p.approvals);
      setAudit((await api.call('audit.list', { limit: 12 }).catch(() => ({ entries: [] }))).entries);
      onError('');
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void refresh(), [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(errText(e));
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card title="Artifacts" action={<Button variant="ghost" onClick={refresh} aria-label="Refresh"><RefreshCw size={14} /></Button>}>
          <form
            className="flex gap-2 border-b border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim()) return;
              run(async () => {
                const r = await api.call('artifacts.create', { type: 'note', name: title, content: { title, body: '' } });
                setSelected(r.artifactId);
                setTitle('');
              });
            }}
          >
            <input id="live-new-title" className={cx(inputCls, 'min-w-0 flex-1')} placeholder="New note title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Button variant="primary">
              <FilePlus2 size={14} /> Create
            </Button>
          </form>
          <ul className="max-h-[420px] divide-y divide-line overflow-y-auto">
            {list.map((a) => (
              <li key={a.id}>
                <button className={cx('flex w-full items-center gap-2 px-4 py-2.5 text-left', selected === a.id ? 'bg-surface-2' : 'hover:bg-surface-2')} onClick={() => setSelected(a.id)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="text-[11px] text-muted">
                      {a.type} · v{a.latestVersion}
                      {a.publishedVersion ? ` · live v${a.publishedVersion}` : ''} · {timeAgo(Date.parse(a.updatedAt))}
                    </span>
                  </span>
                  <Pill tone={stateTone[a.latestState]}>{a.latestState.replace('_', ' ')}</Pill>
                </button>
              </li>
            ))}
            {!list.length && <li className="px-4 py-4 text-[13px] text-muted">No artifacts yet. Create a note above, or let an agent create one over MCP.</li>}
          </ul>
        </Card>

        <Card title="Waiting for approval" action={<Pill tone={approvals.length ? 'agent' : 'good'}>{approvals.length}</Pill>}>
          <ul className="divide-y divide-line">
            {approvals.map((r) => (
              <li key={r.id} className="space-y-2 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {r.artifactName} v{r.version}
                  </span>
                  <AuthorBadge author={{ type: r.requestedBy.type, name: r.requestedBy.type === 'agent' ? (r.requestedBy.client ?? 'Agent') : 'Person' }} />
                </div>
                <p className="text-[12px] text-muted">{r.note}</p>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => run(() => api.call('approvals.approve', { approvalId: r.id }))}>
                    <CheckCircle2 size={14} /> Approve
                  </Button>
                  <Button onClick={() => run(() => api.call('approvals.reject', { approvalId: r.id, note: 'Rejected from the workspace screen' }))}>
                    <XCircle size={14} /> Reject
                  </Button>
                </div>
              </li>
            ))}
            {!approvals.length && <li className="px-4 py-4 text-[13px] text-muted">Nothing to review.</li>}
          </ul>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        {selected ? <ArtifactDetail key={selected} id={selected} onChanged={refresh} onError={onError} /> : <Card><p className="p-5 text-[13px] text-muted">Select an artifact to edit, publish and see its history.</p></Card>}
        <Card
          title="Audit log"
          action={
            <Button
              variant="ghost"
              onClick={() => run(async () => {
                const v = await api.call('audit.verify', {});
                onError(v.ok ? '' : `Audit chain broken at entry ${v.firstBrokenSeq}`);
                setVerified(v.ok ? `Chain verified: ${v.entries} entries, no tampering.` : '');
              })}
            >
              <ShieldCheck size={14} /> Verify chain
            </Button>
          }
        >
          <ul className="divide-y divide-line font-mono text-[11px]">
            {audit.map((e) => (
              <li key={e.seq} className="flex flex-wrap gap-x-3 px-4 py-1.5">
                <span className="text-muted">{new Date(e.at).toLocaleTimeString()}</span>
                <span className={e.principalType === 'agent' ? 'text-agent' : ''}>{e.surface}:{e.principalType}</span>
                <span className={e.ok ? '' : 'text-bad'}>{e.command}</span>
                <span className="min-w-0 truncate text-muted">{e.error ?? e.target ?? ''}</span>
              </li>
            ))}
          </ul>
          {verified && <p className="px-4 pb-3 text-[12px] text-good">{verified}</p>}
        </Card>
      </div>
    </div>
  );
}

function ArtifactDetail({ id, onChanged, onError }: { id: string; onChanged: () => void; onError: (m: string) => void }) {
  const [a, setA] = useState<Artifact | null>(null);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<Out<'artifacts.history'>['versions']>([]);
  const [diff, setDiff] = useState<Out<'artifacts.diff'> | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const [got, h] = await Promise.all([api.call('artifacts.get', { artifactId: id }), api.call('artifacts.history', { artifactId: id })]);
    setA(got);
    setDraft(JSON.stringify(got.version.content, null, 2));
    setHistory(h.versions);
    setDiff(got.publishedVersion && got.publishedVersion !== got.latestVersion ? await api.call('artifacts.diff', { artifactId: id }) : null);
  }, [id]);
  useEffect(() => void load().catch((e) => onError(errText(e))), [load, onError]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      onError(errText(e));
    }
  };
  if (!a) return null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {a.name} <Pill tone={stateTone[a.version.state]}>v{a.version.number} {a.version.state.replace('_', ' ')}</Pill>
        </span>
      }
      action={<AuthorBadge author={{ type: a.version.author.type, name: a.version.author.type === 'agent' ? (a.version.author.client ?? 'Agent') : 'Person' }} />}
    >
      <div className="space-y-3 p-4">
        <textarea id="live-content" spellCheck={false} className={cx(inputCls, 'h-[220px] font-mono text-[12px]')} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              act(async () => {
                let content: unknown;
                try {
                  content = JSON.parse(draft);
                } catch {
                  throw new Error('The content is not valid JSON.');
                }
                await api.call('artifacts.updateDraft', { artifactId: id, content, expectedContentHash: a.version.contentHash });
              })
            }
          >
            Save draft
          </Button>
          <input id="live-publish-note" className={cx(inputCls, 'min-w-0 flex-1')} placeholder="What changed? (for the reviewer)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" disabled={a.version.state !== 'draft' || !note.trim()} onClick={() =>
              act(async () => {
                await api.call('artifacts.requestPublish', { artifactId: id, note });
                setNote('');
              })
            }
          >
            <Send size={14} /> Publish
          </Button>
        </div>
        {diff && (
          <div className="rounded-md border border-line">
            <div className="eyebrow border-b border-line px-3 py-2">
              Changes v{diff.from} → v{diff.to}
            </div>
            <ul className="divide-y divide-line font-mono text-[12px]">
              {diff.changes.map((c) => (
                <li key={c.path} className="flex flex-wrap gap-2 px-3 py-1.5">
                  <Pill tone={c.kind === 'added' ? 'good' : c.kind === 'removed' ? 'bad' : 'accent'}>{c.kind}</Pill>
                  <span className="text-muted">{c.path}</span>
                  {c.before !== undefined && <span className="text-bad line-through">{JSON.stringify(c.before)}</span>}
                  {c.after !== undefined && <span className="text-good">{JSON.stringify(c.after)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="eyebrow mb-1.5 flex items-center gap-1.5">
            <History size={12} /> History
          </div>
          <ul className="space-y-1 text-[12px]">
            {history.map((v) => (
              <li key={v.number} className="flex items-center gap-2">
                <span className="w-8 font-mono text-muted">v{v.number}</span>
                <Pill tone={stateTone[v.state]}>{v.state.replace('_', ' ')}</Pill>
                <span className="text-muted">{v.author.type === 'agent' ? `agent (${v.author.client})` : 'person'}</span>
                <span className="min-w-0 truncate text-muted">{v.note ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
