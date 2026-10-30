import { Bot, ChevronRight, Loader2, Send, Settings2, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { exec } from '../api/commands';
import { Button, cx, inputBase, inputCls, Pill } from '../components/ui';
import { createLiveSession } from './llm';
import { scenarios } from './scripted';
import type { ChatItem, LiveConfig, Sink } from './types';

const agent = { type: 'agent', name: 'Copilot' } as const;
let idSeq = 0;
const nid = () => `c${++idSeq}`;

const defaults: Record<LiveConfig['provider'], Pick<LiveConfig, 'baseUrl' | 'model'>> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
};

export function Copilot({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ChatItem[]>([
    {
      id: nid(),
      role: 'assistant',
      text: 'Hi Tim. I work through the same tools an external MCP client gets, as an agent principal: I can draft, simulate and request publishing, but a human approves agent changes.',
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'scripted' | 'live'>('scripted');
  const [showCfg, setShowCfg] = useState(false);
  const [cfg, setCfg] = useState<LiveConfig>({ provider: 'anthropic', apiKey: '', ...defaults.anthropic });
  const live = useRef<ReturnType<typeof createLiveSession> | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message whenever the list changes, which the body does not read
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [items]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider settings are the trigger to start a new conversation, not values read in the body
  useEffect(() => {
    live.current = null; // new provider settings start a new conversation
  }, [cfg.provider, cfg.baseUrl, cfg.model, cfg.apiKey]);

  const sink: Sink = {
    say: (text, actions) => setItems((xs) => [...xs, { id: nid(), role: 'assistant', text, actions }]),
    tool: async (name, toolInput) => {
      const id = nid();
      setItems((xs) => [...xs, { id, role: 'tool', name, input: toolInput, status: 'running' }]);
      try {
        const output = await exec(name, toolInput, agent);
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, output, status: 'done' } : x)));
        return output;
      } catch (err) {
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, error: (err as Error).message, status: 'error' } : x)));
        throw err;
      }
    },
  };

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setInput('');
    setItems((xs) => [...xs, { id: nid(), role: 'user', text }]);
    setBusy(true);
    try {
      if (mode === 'live') {
        if (!cfg.apiKey || !cfg.model) {
          sink.say('Live mode needs a model and an API key. Open the settings (gear icon) to add them.');
          setShowCfg(true);
          return;
        }
        live.current ??= createLiveSession(cfg);
        await live.current(text, sink);
      } else {
        const s = scenarios.find((x) => x.match.test(text));
        if (s) await s.run(sink);
        else
          sink.say(
            'In scripted mode I can do the three tasks below. Switch to live mode with your own API key to ask anything else; I will use the same tools.',
          );
      }
    } catch (err) {
      const msg = (err as Error).message;
      sink.say(
        /fetch|network|cors|failed/i.test(msg)
          ? `I could not reach the model API (${msg}). The published demo link blocks outside network calls; run the app locally (pnpm dev) for live mode.`
          : `Something went wrong: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-agent-soft text-agent">
          <Bot size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">Copilot</div>
          <div className="text-[11px] text-muted">
            Agent principal · MCP tools · {mode === 'live' ? `${cfg.provider}, ${cfg.model || 'no model'}` : 'scripted'}
          </div>
        </div>
        <div className="flex rounded-md border border-line p-0.5 text-[11px]">
          {(['scripted', 'live'] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMode(m)}
              className={cx('rounded px-2 py-0.5 font-medium capitalize', mode === m ? 'bg-agent-soft text-agent' : 'text-muted')}
            >
              {m}
            </button>
          ))}
        </div>
        <Button variant="ghost" onClick={() => setShowCfg(!showCfg)} aria-label="Live mode settings">
          <Settings2 size={15} />
        </Button>
        <Button variant="ghost" onClick={onClose} aria-label="Close copilot">
          <X size={15} />
        </Button>
      </header>

      {showCfg && (
        <div className="space-y-2 border-b border-line bg-surface-2 px-4 py-3 text-[12px]">
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2">
              <span className="mb-1 block text-muted">Provider</span>
              <select
                id="llm-provider"
                className={inputCls}
                value={cfg.provider}
                onChange={(e) => {
                  const provider = e.target.value as LiveConfig['provider'];
                  setCfg({ ...cfg, provider, ...defaults[provider] });
                }}
              >
                <option value="anthropic">Anthropic-compatible (Messages API)</option>
                <option value="openai">OpenAI-compatible (Chat Completions)</option>
              </select>
            </label>
            <label>
              <span className="mb-1 block text-muted">Base URL</span>
              <input
                id="llm-base"
                className={cx(inputCls, 'font-mono')}
                value={cfg.baseUrl}
                onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
              />
            </label>
            <label>
              <span className="mb-1 block text-muted">Model</span>
              <input
                id="llm-model"
                className={cx(inputCls, 'font-mono')}
                value={cfg.model}
                placeholder="model id"
                onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              />
            </label>
            <label className="col-span-2">
              <span className="mb-1 block text-muted">API key</span>
              <input
                id="llm-key"
                type="password"
                autoComplete="off"
                className={cx(inputCls, 'font-mono')}
                value={cfg.apiKey}
                onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
              />
            </label>
          </div>
          <p className="text-muted">
            The key stays in this tab’s memory and is sent only to the base URL above. Browser calls need the provider to allow CORS; the
            published demo link blocks outside calls, so use live mode with <code className="font-mono">pnpm dev</code>.
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {items.map((it) =>
          it.role === 'tool' ? (
            <ToolCard key={it.id} item={it} />
          ) : (
            <div key={it.id} className={cx('flex', it.role === 'user' && 'justify-end')}>
              <div
                className={cx(
                  'max-w-[92%] rounded-lg px-3 py-2 text-[13px] leading-relaxed',
                  it.role === 'user' ? 'bg-accent text-accent-fg' : 'bg-surface-2',
                )}
              >
                <div className="whitespace-pre-wrap">{it.text}</div>
                {it.actions && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {it.actions.map((a) => (
                      <Button key={a.label} variant="agent" onClick={a.run}>
                        {a.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Loader2 size={14} className="animate-spin" /> Working…
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="border-t border-line px-4 py-3" style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {scenarios.map((s) => (
            <button
              type="button"
              key={s.prompt}
              disabled={busy}
              onClick={() => ask(s.prompt)}
              className="rounded-full border border-line px-2.5 py-1 text-left text-[11px] text-muted hover:border-agent hover:text-agent disabled:opacity-50"
            >
              {s.prompt}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <input
            id="copilot-input"
            className={cx(inputBase, 'min-w-0 flex-1')}
            placeholder="Ask the copilot…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button variant="primary" disabled={busy || !input.trim()} aria-label="Send">
            <Send size={14} />
          </Button>
        </form>
      </div>
    </div>
  );
}

function ToolCard({ item }: { item: Extract<ChatItem, { role: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-agent/30 bg-surface text-[12px]">
      <button type="button" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={cx('text-muted transition-transform', open && 'rotate-90')} />
        <Wrench size={12} className="text-agent" />
        <code className="font-mono font-medium text-agent">{item.name}</code>
        <span className="ml-auto">
          {item.status === 'running' && <Loader2 size={12} className="animate-spin text-muted" />}
          {item.status === 'done' && <Pill tone="good">ok</Pill>}
          {item.status === 'error' && <Pill tone="bad">error</Pill>}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-line px-2.5 py-2">
          <pre className="max-h-[160px] overflow-auto font-mono text-[11px] text-muted">{JSON.stringify(item.input, null, 2)}</pre>
          {item.output !== undefined && (
            <pre className="max-h-[200px] overflow-auto font-mono text-[11px]">{JSON.stringify(item.output, null, 2)}</pre>
          )}
          {item.error && <div className="text-bad">{item.error}</div>}
        </div>
      )}
    </div>
  );
}
