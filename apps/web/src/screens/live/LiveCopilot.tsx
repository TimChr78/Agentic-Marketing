import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronRight, Loader2, Send, Wrench } from 'lucide-react';
import { Button, Card, Pill, cx, inputCls } from '../../components/ui';

// The copilot on the real API: the server runs the conversation with the workspace's copilot
// provider, as an MCP client with an agent principal. Tool calls stream in as they happen.

type Item =
  | { id: string; role: 'user' | 'assistant' | 'error'; text: string }
  | { id: string; role: 'tool'; name: string; input: unknown; output?: unknown; ok?: boolean };

type Event =
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; id: string; name: string; ok: boolean; output: unknown }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; history: unknown[]; usage: { inputTokens: number; outputTokens: number } };

let seq = 0;
const nid = () => `m${++seq}`;

const SUGGESTIONS = ['What is in this workspace?', 'Draft a win-back segment for people who have not ordered in 90 days', 'Why did the last AI decisions take their fallback?'];

export function LiveCopilot() {
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [items]);

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setInput('');
    setBusy(true);
    setItems((xs) => [...xs, { id: nid(), role: 'user', text }]);
    const on = (e: Event) => {
      if (e.type === 'tool') setItems((xs) => [...xs, { id: e.id, role: 'tool', name: e.name, input: e.input }]);
      else if (e.type === 'toolResult') setItems((xs) => xs.map((x) => (x.id === e.id && x.role === 'tool' ? { ...x, output: e.output, ok: e.ok } : x)));
      else if (e.type === 'text') setItems((xs) => [...xs, { id: nid(), role: 'assistant', text: e.text }]);
      else if (e.type === 'error') setItems((xs) => [...xs, { id: nid(), role: 'error', text: e.message }]);
      else {
        setHistory(e.history);
        setTokens((t) => t + e.usage.inputTokens + e.usage.outputTokens);
      }
    };
    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        on({ type: 'error', message: body.message ?? res.statusText });
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) on(JSON.parse(l));
      }
    } catch (err) {
      on({ type: 'error', message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Bot size={16} /> Copilot
        </span>
      }
      action={
        <span className="flex items-center gap-2 text-[11px] text-muted">
          {tokens > 0 && `${tokens} tokens`}
          <Pill tone="agent">agent · drafts only</Pill>
          {items.length > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setItems([]);
                setHistory([]);
              }}
            >
              New chat
            </Button>
          )}
        </span>
      }
    >
      <div className="flex h-[560px] flex-col">
        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-[13px]">
          {!items.length && (
            <div className="space-y-3 text-muted">
              <p>
                The copilot uses the same MCP tools an external agent gets, as an agent acting for you: it can read, draft, simulate and request publishing. It cannot send, approve, erase people or change settings, and everything it does is in the audit log.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} variant="secondary" onClick={() => ask(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {items.map((x) =>
            x.role === 'tool' ? (
              <details key={x.id} className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-[12px]">
                <summary className="flex cursor-pointer items-center gap-1.5">
                  <Wrench size={13} className="text-agent" />
                  <span className="font-mono">{x.name}</span>
                  {x.ok === undefined ? <Loader2 size={13} className="animate-spin" /> : !x.ok && <Pill tone="bad">error</Pill>}
                  <ChevronRight size={13} className="ml-auto text-muted" />
                </summary>
                <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">
                  {JSON.stringify({ input: x.input, output: x.output }, null, 1)}
                </pre>
              </details>
            ) : (
              <div
                key={x.id}
                className={cx(
                  'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2',
                  x.role === 'user' ? 'ml-auto bg-accent-soft' : x.role === 'error' ? 'bg-bad-soft text-bad' : 'bg-surface-2',
                )}
              >
                {x.text}
              </div>
            ),
          )}
          {busy && <Loader2 size={16} className="animate-spin text-muted" />}
          <div ref={end} />
        </div>
        <form
          className="flex gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <input className={cx(inputCls, 'min-w-0 flex-1')} placeholder="Ask or give a task…" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message to the copilot" />
          <Button variant="primary" disabled={busy || !input.trim()}>
            <Send size={14} /> Send
          </Button>
        </form>
      </div>
    </Card>
  );
}
