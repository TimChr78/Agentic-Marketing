import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bot, CheckCircle2, FlaskConical, KeyRound, Play, Plus, Save, Send, Trash2, XCircle } from 'lucide-react';
import { Button, Card, Pill, cx, inputCls, timeAgo } from '../../components/ui';
import { api, errText, type Out } from '../liveApi';

// The AI runtime on the real API: providers with the workspace's own keys and budgets, prompts
// with their test cases, and the decision log of every AI call.

type Provider = Out<'aiProviders.list'>['providers'][number];

const STARTER_PROMPT = {
  kind: 'decide',
  instructions: 'Choose the offer that fits this customer best, based on what they bought and looked at.',
  model: 'default',
  options: [
    { key: 'vip', description: 'Loyal, high-value customer: early access, no discount' },
    { key: 'discount', description: 'Price-sensitive or hesitating: 10% off' },
    { key: 'standard', description: 'Everyone else: the regular newsletter offer' },
  ],
  tests: [
    { name: 'Big spender', traits: { lifetime_value: 2400 }, events: [{ name: 'Order Completed', properties: { total: 899 } }], expect: { options: ['vip'] } },
    { name: 'Window shopper', traits: { lifetime_value: 0 }, events: [{ name: 'Product Viewed', properties: { name: 'Fjell 2 tent' } }], expect: { options: ['discount', 'standard'] } },
  ],
};

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function LiveAi({ canAdmin, onError }: { canAdmin: boolean; onError: (m: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (open)
    return (
      <PromptEditor id={open} onError={onError} onBack={() => setOpen(null)} />
    );
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Providers canAdmin={canAdmin} onError={onError} />
        <Prompts onOpen={setOpen} onError={onError} />
      </div>
      <DecisionLog onError={onError} />
    </div>
  );
}

function Providers({ canAdmin, onError }: { canAdmin: boolean; onError: (m: string) => void }) {
  const [list, setList] = useState<Provider[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: 'Anthropic',
    kind: 'anthropic-compatible' as Provider['kind'],
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5-5',
    fast: '',
    apiKey: '',
    budget: '',
    journeys: true,
    copilot: true,
  });
  const load = useCallback(async () => {
    try {
      setList((await api.call('aiProviders.list', {})).providers);
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  const kindDefaults = (kind: Provider['kind']) =>
    kind === 'anthropic-compatible'
      ? { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' }
      : { name: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', model: '' };

  return (
    <Card
      title="AI providers"
      action={
        canAdmin && (
          <Button variant="ghost" onClick={() => setAdding((x) => !x)}>
            <Plus size={14} /> Add
          </Button>
        )
      }
    >
      {adding && (
        <form
          className="grid gap-2 border-b border-line p-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.call('aiProviders.create', {
                name: form.name,
                kind: form.kind,
                baseUrl: form.baseUrl,
                models: { default: form.model, ...(form.fast ? { fast: form.fast } : {}) },
                apiKey: form.apiKey,
                monthlyTokenBudget: form.budget ? Number(form.budget) : null,
                useFor: [...(form.journeys ? (['journeys'] as const) : []), ...(form.copilot ? (['copilot'] as const) : [])],
              });
              setAdding(false);
              setForm((f) => ({ ...f, apiKey: '' }));
              onError('');
              await load();
            } catch (err) {
              onError(errText(err));
            }
          }}
        >
          <label className="text-[12px] text-muted">
            API format
            <select
              className={inputCls}
              value={form.kind}
              onChange={(e) => {
                const kind = e.target.value as Provider['kind'];
                setForm((f) => ({ ...f, kind, ...kindDefaults(kind) }));
              }}
            >
              <option value="anthropic-compatible">Anthropic-compatible</option>
              <option value="openai-compatible">OpenAI-compatible (OpenAI, Mistral, Ollama, vLLM, LiteLLM…)</option>
            </select>
          </label>
          <label className="text-[12px] text-muted">
            Name
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="text-[12px] text-muted sm:col-span-2">
            Base URL
            <input className={inputCls} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label className="text-[12px] text-muted">
            Model
            <input className={inputCls} value={form.model} required onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
          <label className="text-[12px] text-muted">
            Fast model (optional)
            <input className={inputCls} value={form.fast} onChange={(e) => setForm({ ...form, fast: e.target.value })} />
          </label>
          <label className="text-[12px] text-muted">
            API key (write-only)
            <input className={inputCls} type="password" required autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </label>
          <label className="text-[12px] text-muted">
            Monthly token budget (empty: none)
            <input className={inputCls} inputMode="numeric" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value.replace(/\D/g, '') })} />
          </label>
          <div className="flex items-center gap-4 text-[13px] sm:col-span-2">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.journeys} onChange={(e) => setForm({ ...form, journeys: e.target.checked })} /> Journeys & prompt tests
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.copilot} onChange={(e) => setForm({ ...form, copilot: e.target.checked })} /> Copilot
            </label>
            <Button variant="primary" className="ml-auto">
              <KeyRound size={14} /> Save provider
            </Button>
          </div>
        </form>
      )}
      <ul className="divide-y divide-line">
        {list.map((p) => (
          <li key={p.id} className="flex items-center gap-2.5 px-4 py-2.5">
            <Bot size={15} className="text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {p.name} <span className="font-normal text-muted">· {p.models.default}</span>
              </span>
              <span className="text-[11px] text-muted">
                {p.kind} · {fmt(p.usedThisMonth)}
                {p.monthlyTokenBudget !== null ? ` of ${fmt(p.monthlyTokenBudget)}` : ''} tokens this month
                {p.hasApiKey ? '' : ' · no key'}
              </span>
            </span>
            {p.useFor.map((u) => (
              <Pill key={u} tone="agent">
                {u}
              </Pill>
            ))}
            {canAdmin && (
              <Button
                variant="ghost"
                aria-label={`Delete ${p.name}`}
                onClick={async () => {
                  if (!confirm(`Delete ${p.name} and its key? AI steps without a provider take their fallback.`)) return;
                  try {
                    await api.call('aiProviders.delete', { id: p.id });
                    await load();
                  } catch (e) {
                    onError(errText(e));
                  }
                }}
              >
                <Trash2 size={14} />
              </Button>
            )}
          </li>
        ))}
        {!list.length && (
          <li className="px-4 py-4 text-[13px] text-muted">
            No provider yet. Add one with your own API key; AI steps take their fallback until then.
          </li>
        )}
      </ul>
    </Card>
  );
}

function Prompts({ onOpen, onError }: { onOpen: (id: string) => void; onError: (m: string) => void }) {
  const [list, setList] = useState<Out<'artifacts.list'>['artifacts']>([]);
  const [name, setName] = useState('');
  useEffect(() => {
    api
      .call('artifacts.list', { type: 'prompt' })
      .then((r) => setList(r.artifacts))
      .catch((e) => onError(errText(e)));
  }, [onError]);
  return (
    <Card title="Prompts" action={<Pill>{list.length}</Pill>}>
      <form
        className="flex gap-2 border-b border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.call('artifacts.create', { type: 'prompt', name: name || 'Next best offer', content: STARTER_PROMPT });
            onOpen(r.artifactId);
          } catch (err) {
            onError(errText(err));
          }
        }}
      >
        <input className={cx(inputCls, 'min-w-0 flex-1')} placeholder="New prompt name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New prompt name" />
        <Button variant="primary">
          <Plus size={14} /> Create
        </Button>
      </form>
      <ul className="divide-y divide-line">
        {list.map((x) => (
          <li key={x.id}>
            <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2" onClick={() => onOpen(x.id)}>
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
        {!list.length && <li className="px-4 py-4 text-[13px] text-muted">No prompts yet. AI decision and text steps in journeys use them.</li>}
      </ul>
    </Card>
  );
}

function PromptEditor({ id, onBack, onError }: { id: string; onBack: () => void; onError: (m: string) => void }) {
  const [a, setA] = useState<Out<'artifacts.get'> | null>(null);
  const [json, setJson] = useState('');
  const [status, setStatus] = useState('');
  const [tests, setTests] = useState<Out<'prompts.test'> | null>(null);
  const [running, setRunning] = useState(false);
  const load = useCallback(async () => {
    try {
      const got = await api.call('artifacts.get', { artifactId: id });
      setA(got);
      setJson(JSON.stringify(got.version.content, null, 2));
    } catch (e) {
      onError(errText(e));
    }
  }, [id, onError]);
  useEffect(() => void load(), [load]);
  if (!a) return <p className="text-muted">Loading…</p>;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={onBack} aria-label="Back to AI">
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
                  onError(e instanceof SyntaxError ? 'The prompt is not valid JSON.' : errText(e));
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
                  const r = await api.call('artifacts.requestPublish', { artifactId: id, note: 'Published from the AI screen' });
                  setStatus(r.status === 'published' ? `Published v${r.version}` : 'Sent for approval');
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
          <textarea className={cx(inputCls, 'h-[520px] font-mono text-[12px]')} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} aria-label="Prompt (JSON)" />
        </div>
      </Card>
      <Card
        title="Test cases"
        action={
          <Button
            variant="agent"
            disabled={running}
            onClick={async () => {
              setRunning(true);
              try {
                setTests(await api.call('prompts.test', { artifactId: id, version: a.version.number }));
                onError('');
              } catch (e) {
                onError(errText(e));
              } finally {
                setRunning(false);
              }
            }}
          >
            <Play size={14} /> {running ? 'Running…' : `Run on v${a.version.number}`}
          </Button>
        }
      >
        {tests ? (
          <ul className="divide-y divide-line">
            <li className="px-4 py-2 text-[12px] text-muted">
              v{tests.version}: {tests.passed} passed, {tests.failed} failed
            </li>
            {tests.results.map((r) => (
              <li key={r.name} className="px-4 py-2.5 text-[13px]">
                <div className="flex items-center gap-2 font-medium">
                  {r.passed ? <CheckCircle2 size={15} className="text-good" /> : <XCircle size={15} className="text-bad" />}
                  {r.name}
                </div>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{JSON.stringify(r.answer, null, 1)}</pre>
                {r.problems.map((p) => (
                  <p key={p} className="text-[12px] text-bad">
                    {p}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted">
            Runs every test case against the journeys provider. Each person is sent as delimited data; the answer must be one of the options, and texts must pass the length and phrase checks.
          </p>
        )}
      </Card>
    </div>
  );
}

const statusTone = { done: 'good', fallback: 'agent', failed: 'bad', pending: 'neutral', running: 'neutral' } as const;

function DecisionLog({ onError }: { onError: (m: string) => void }) {
  const [calls, setCalls] = useState<Out<'ai.calls'>['calls']>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCalls((await api.call('ai.calls', { limit: 50 })).calls);
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  return (
    <Card
      title="Decision log"
      action={
        <Button variant="ghost" onClick={load}>
          Refresh
        </Button>
      }
    >
      <ul className="divide-y divide-line">
        {calls.map((c) => (
          <li key={c.id}>
            <button className="w-full px-4 py-2.5 text-left hover:bg-surface-2" onClick={() => setOpen(open === c.id ? null : c.id)}>
              <span className="flex items-center gap-2 text-[13px]">
                <Pill tone={statusTone[c.status]}>{c.status}</Pill>
                <span className="font-medium">{c.kind}</span>
                {c.node && <span className="text-muted">· {c.node}</span>}
                <span className="ml-auto text-[11px] text-muted">
                  {c.inputTokens + c.outputTokens} tok · {c.latencyMs ?? '–'} ms · {timeAgo(Date.parse(c.createdAt))}
                </span>
              </span>
              {(c.rationale || c.error) && <span className={cx('mt-1 block text-[12px]', c.error ? 'text-muted' : '')}>{c.rationale ?? c.error}</span>}
            </button>
            {open === c.id && (
              <pre className="mx-4 mb-3 max-h-[320px] overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px]">
                {JSON.stringify({ model: c.model, prompt: c.promptId && `${c.promptId}@${c.promptVersion}`, profile: c.profileId, input: c.input, output: c.output, error: c.error }, null, 2)}
              </pre>
            )}
          </li>
        ))}
        {!calls.length && <li className="px-4 py-4 text-[13px] text-muted">No AI calls yet.</li>}
      </ul>
    </Card>
  );
}
