import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FlaskConical, Plus, Save, Send } from 'lucide-react';
import { Button, Card, Pill, cx, inputCls, timeAgo } from '../../components/ui';
import { api, errText, type Out } from '../liveApi';

// Web experiences on the real API: the definition as JSON (what agents edit too), a preview of
// each variant, and experiment results.

const STARTER = {
  placement: 'home_hero',
  description: 'Hero for returning tent shoppers',
  priority: 100,
  targeting: { session: 'Product Viewed', count: { gte: 2 } },
  variants: [
    { id: 'a', name: 'Lifestyle', weight: 50, content: { html: '<h2>Your next camp starts here</h2>' } },
    { id: 'b', name: 'Discount', weight: 50, content: { html: '<h2>10% off tents this week</h2>' } },
  ],
  holdoutPercent: 10,
  goal: { event: 'Order Completed' },
  trigger: { type: 'immediate' },
};

const pct = (n: number | null) => (n === null ? '–' : `${(n * 100).toFixed(1)}%`);

export function LiveExperiences({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Out<'artifacts.list'>['artifacts']>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = useCallback(async () => {
    try {
      setList((await api.call('artifacts.list', {})).artifacts.filter((a) => a.type === 'experience'));
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  if (open)
    return (
      <Editor
        id={open}
        onError={onError}
        onBack={() => {
          setOpen(null);
          void load();
        }}
      />
    );

  return (
    <Card title="Web experiences" action={<Pill>{list.length}</Pill>}>
      <form
        className="flex gap-2 border-b border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.call('artifacts.create', { type: 'experience', name: name || 'New experience', content: STARTER });
            setName('');
            setOpen(r.artifactId);
          } catch (err) {
            onError(errText(err));
          }
        }}
      >
        <input className={cx(inputCls, 'min-w-0 flex-1')} placeholder="New experience name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New experience name" />
        <Button variant="primary">
          <Plus size={14} /> Create
        </Button>
      </form>
      <ul className="divide-y divide-line">
        {list.map((x) => (
          <li key={x.id}>
            <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2" onClick={() => setOpen(x.id)}>
              <FlaskConical size={15} className="text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{x.name}</span>
                <span className="text-[11px] text-muted">
                  v{x.latestVersion}
                  {x.publishedVersion ? ` · live v${x.publishedVersion}` : ''} · {timeAgo(Date.parse(x.updatedAt))}
                </span>
              </span>
              <Pill tone={x.publishedVersion ? 'good' : 'neutral'}>{x.publishedVersion ? 'live' : x.latestState.replace('_', ' ')}</Pill>
            </button>
          </li>
        ))}
        {!list.length && <li className="px-4 py-4 text-[13px] text-muted">No experiences yet. Mark elements on your site with data-am-placement and create one.</li>}
      </ul>
    </Card>
  );
}

function Editor({ id, onBack, onError }: { id: string; onBack: () => void; onError: (m: string) => void }) {
  const [a, setA] = useState<Out<'artifacts.get'> | null>(null);
  const [json, setJson] = useState('');
  const [results, setResults] = useState<Out<'experiences.results'> | null>(null);
  const [status, setStatus] = useState('');
  const load = useCallback(async () => {
    try {
      const got = await api.call('artifacts.get', { artifactId: id });
      setA(got);
      setJson(JSON.stringify(got.version.content, null, 2));
      setResults(got.publishedVersion ? await api.call('experiences.results', { artifactId: id }) : null);
    } catch (e) {
      onError(errText(e));
    }
  }, [id, onError]);
  useEffect(() => void load(), [load]);
  if (!a) return <p className="text-muted">Loading…</p>;

  let variants: { id: string; name: string; content: { html?: string } }[] = [];
  try {
    variants = JSON.parse(json).variants ?? [];
  } catch {}

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={onBack} aria-label="Back to experiences">
              <ArrowLeft size={16} />
            </Button>
            {a.name}
          </span>
        }
        action={
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                try {
                  const r = await api.call('artifacts.updateDraft', { artifactId: id, content: JSON.parse(json), expectedContentHash: a.version.contentHash });
                  setStatus(`Saved draft v${r.version}`);
                  onError('');
                  await load();
                } catch (e) {
                  onError(e instanceof SyntaxError ? 'The definition is not valid JSON.' : errText(e));
                }
              }}
            >
              <Save size={14} /> Save
            </Button>
            <Button
              variant="primary"
              disabled={a.version.state !== 'draft'}
              onClick={async () => {
                try {
                  const r = await api.call('artifacts.requestPublish', { artifactId: id, note: 'Published from the experiences screen' });
                  setStatus(r.status === 'published' ? `Published v${r.version} (live within 30 s)` : 'Sent for approval');
                  await load();
                } catch (e) {
                  onError(errText(e));
                }
              }}
            >
              <Send size={14} /> Publish
            </Button>
          </div>
        }
      >
        <div className="px-4 pt-2 text-[11px] text-muted">
          v{a.version.number} {a.version.state.replace('_', ' ')} {status && `· ${status}`}
        </div>
        <div className="p-3">
          <textarea className={cx(inputCls, 'h-[480px] font-mono text-[12px]')} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} aria-label="Experience definition (JSON)" />
        </div>
      </Card>
      <div className="flex min-w-0 flex-col gap-5">
        <Card title="Results">
          {results ? (
            <div className="overflow-x-auto">
              <table className="num w-full text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-wider text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2">Variant</th>
                    <th className="px-4 py-2 text-right">Exposed</th>
                    <th className="px-4 py-2 text-right">Converted</th>
                    <th className="px-4 py-2 text-right">Rate</th>
                    <th className="px-4 py-2 text-right">Lift</th>
                    <th className="px-4 py-2 text-right">p</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {results.variants.map((v) => (
                    <tr key={v.variant}>
                      <td className="px-4 py-2">
                        {v.variant} {v.variant === results.control && <Pill>control</Pill>}
                      </td>
                      <td className="px-4 py-2 text-right">{v.exposed}</td>
                      <td className="px-4 py-2 text-right">{v.converted}</td>
                      <td className="px-4 py-2 text-right">{pct(v.rate)}</td>
                      <td className={cx('px-4 py-2 text-right', (v.lift ?? 0) > 0 ? 'text-good' : (v.lift ?? 0) < 0 ? 'text-bad' : '')}>{pct(v.lift)}</td>
                      <td className="px-4 py-2 text-right">{v.pValue === null ? '–' : v.pValue.toFixed(3)}</td>
                    </tr>
                  ))}
                  {!results.variants.length && (
                    <tr>
                      <td colSpan={6} className="px-4 py-3 text-muted">
                        No exposures yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="px-4 py-2 text-[11px] text-muted">
                Goal: {results.goal ?? 'none'}. {results.note}
              </p>
            </div>
          ) : (
            <p className="px-4 py-3 text-[13px] text-muted">Publish the experience to start collecting results.</p>
          )}
        </Card>
        {variants.map((v) => (
          <Card key={v.id} title={`Variant ${v.id} · ${v.name}`}>
            {v.content?.html !== undefined ? (
              <iframe title={`Variant ${v.id}`} sandbox="" className="h-[160px] w-full bg-white" srcDoc={`<body style="font-family:system-ui;margin:16px">${v.content.html}</body>`} />
            ) : (
              <p className="px-4 py-3 text-[12px] text-muted">JSON content: the site renders it.</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
