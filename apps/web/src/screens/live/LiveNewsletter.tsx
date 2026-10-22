import { useCallback, useEffect, useState } from 'react';
import { Ban, Copy, Eye, Newspaper, Send } from 'lucide-react';
import { Button, Card, Mono, Pill, cx, inputCls, timeAgo } from '../../components/ui';
import { api, errText, type Out } from '../liveApi';

// Newsletter: signup forms (with the HTML to paste into a site), broadcasts with their status and
// results, and test sends of a template to yourself. Forms and broadcasts are artifacts, so they
// are drafted and published under Artifacts & approvals, by a person or an agent.

type Artifacts = Out<'artifacts.list'>['artifacts'];
type Status = Out<'broadcasts.status'>;

const runTone = { not_scheduled: 'neutral', scheduled: 'agent', running: 'accent', done: 'good', cancelled: 'warn', failed: 'bad' } as const;

const formSnippet = (id: string) => `<form method="post" action="${location.origin}/f/${id}">
  <input type="email" name="email" required placeholder="you@example.com">
  <input type="text" name="firstName" placeholder="First name">
  <input type="text" name="am_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <button>Subscribe</button>
</form>`;

export function LiveNewsletter({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Artifacts>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [audience, setAudience] = useState<Record<string, string>>({});
  const [snippet, setSnippet] = useState<string | null>(null);
  const [template, setTemplate] = useState('');
  const [testResult, setTestResult] = useState('');

  const load = useCallback(async () => {
    try {
      const all = (await api.call('artifacts.list', {})).artifacts;
      setList(all);
      const broadcasts = all.filter((a) => a.type === 'broadcast');
      const entries = await Promise.all(
        broadcasts.map(async (b) => [b.id, await api.call('broadcasts.status', { artifactId: b.id })] as const),
      );
      setStatus(Object.fromEntries(entries));
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  const forms = list.filter((a) => a.type === 'form');
  const broadcasts = list.filter((a) => a.type === 'broadcast');
  const templates = list.filter((a) => a.type === 'email_template');

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card title="Broadcasts" action={<Pill>{broadcasts.length}</Pill>}>
          {broadcasts.length === 0 && (
            <p className="p-4 text-[13px] text-muted">
              No broadcasts yet. Create a broadcast artifact (a published template and a segment) under Artifacts & approvals, or ask an agent to draft
              this week's issue.
            </p>
          )}
          <ul className="divide-y divide-line">
            {broadcasts.map((b) => {
              const s = status[b.id];
              const m = s?.messages ?? {};
              return (
                <li key={b.id} className="space-y-1.5 px-4 py-3 text-[13px]">
                  <div className="flex items-center gap-2">
                    <Newspaper size={15} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
                    {s && <Pill tone={runTone[s.run.status]}>{s.run.status.replace('_', ' ')}</Pill>}
                  </div>
                  {s && s.run.status !== 'not_scheduled' && (
                    <p className="text-[12px] text-muted">
                      {s.run.status === 'scheduled' && s.run.sendAt ? `Sends ${new Date(s.run.sendAt).toLocaleString()} · ` : ''}
                      {s.run.recipients} recipients, {s.run.queued} queued, {s.run.skipped} skipped · sent {m.sent ?? 0}, delivered {m.delivered ?? 0},
                      clicked {m.clicked ?? 0}, unsubscribed {m.unsubscribed ?? 0}, bounced {m.bounced ?? 0}
                      {s.run.error ? ` · ${s.run.error}` : ''}
                    </p>
                  )}
                  {audience[b.id] && <p className="text-[12px]">{audience[b.id]}</p>}
                  <div className="flex gap-2">
                    <Button
                      onClick={async () => {
                        try {
                          const p = await api.call('broadcasts.preview', { artifactId: b.id });
                          setAudience((a) => ({ ...a, [b.id]: `Audience ${p.audience}, would send ${p.wouldSend}.` }));
                        } catch (e) {
                          onError(errText(e));
                        }
                      }}
                    >
                      <Eye size={14} /> Preview audience
                    </Button>
                    {s && (s.run.status === 'scheduled' || s.run.status === 'running') && (
                      <Button
                        onClick={async () => {
                          if (!confirm(`Cancel "${b.name}"? Nobody else will get it.`)) return;
                          try {
                            await api.call('broadcasts.cancel', { artifactId: b.id });
                            void load();
                          } catch (e) {
                            onError(errText(e));
                          }
                        }}
                      >
                        <Ban size={14} /> Cancel
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Send a test">
          <div className="space-y-2 p-3 text-[13px]">
            <p className="text-[12px] text-muted">The latest version of a template, with its sample data and "[Test]" in the subject, to you.</p>
            <div className="flex gap-2">
              <select className={cx(inputCls, 'min-w-0 flex-1')} value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Template">
                <option value="">Choose a template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <Button
                variant="primary"
                disabled={!template}
                onClick={async () => {
                  try {
                    const r = await api.call('templates.sendTest', { artifactId: template });
                    setTestResult(`Sent "${r.subject}" to ${r.to} through ${r.provider}.`);
                    onError('');
                  } catch (e) {
                    onError(errText(e));
                  }
                }}
              >
                <Send size={14} /> Send test
              </Button>
            </div>
            {testResult && <p className="text-[12px] text-good">{testResult}</p>}
          </div>
        </Card>
      </div>
      <Card title="Signup forms" action={<Pill>{forms.length}</Pill>}>
        {forms.length === 0 && <p className="p-4 text-[13px] text-muted">No signup forms yet. Create a form artifact under Artifacts & approvals.</p>}
        <ul className="divide-y divide-line">
          {forms.map((f) => (
            <li key={f.id} className="space-y-1.5 px-4 py-3 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                <Pill tone={f.publishedVersion ? 'good' : 'neutral'}>{f.publishedVersion ? `live v${f.publishedVersion}` : 'draft'}</Pill>
              </div>
              <p className="text-[11px] text-muted">
                <Mono>{f.id}</Mono> · {timeAgo(Date.parse(f.updatedAt))}
              </p>
              <Button onClick={() => setSnippet(snippet === f.id ? null : f.id)}>
                <Copy size={14} /> HTML for your site
              </Button>
              {snippet === f.id && (
                <>
                  <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-[11px]">{formSnippet(f.id)}</pre>
                  <p className="text-[11px] text-muted">
                    Posts to this server; behind a site proxy, use your links URL (PUBLIC_LINKS_URL) instead. Works without JavaScript.
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
