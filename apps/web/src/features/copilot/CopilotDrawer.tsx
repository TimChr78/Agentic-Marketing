import { ChevronRight, Loader2, Send, Trash2, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errText } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, Drawer, EmptyState, IconButton, JsonView, StatusPill, Tag, Textarea, timeAgo, useConfirm } from '../../ui';

// The copilot talks to the real API: the server runs the conversation with the workspace's
// copilot provider, as an MCP client with an agent principal. Text streams in as the model
// writes it, tool calls as they happen; conversations are kept on the server per person, so
// earlier ones can be opened and deleted. It drafts and simulates; a person approves.

type Item =
  | { id: string; role: 'user' | 'assistant' | 'error'; text: string }
  | { id: string; role: 'tool'; name: string; input: unknown; output?: unknown; ok?: boolean };

type Event =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'user'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; id: string; name: string; ok: boolean; output: unknown }
  | { type: 'error'; message: string }
  | { type: 'done'; conversationId: string; usage: { inputTokens: number; outputTokens: number } };

/** Folds one event into the conversation as shown: deltas grow the answer being written. */
function apply(xs: Item[], e: Event, streaming: { id: string | null }): Item[] {
  if (e.type === 'user') return [...xs, { id: nid(), role: 'user', text: e.text }];
  if (e.type === 'tool') {
    streaming.id = null;
    return [...xs, { id: e.id, role: 'tool', name: e.name, input: e.input }];
  }
  if (e.type === 'toolResult') return xs.map((x) => (x.id === e.id && x.role === 'tool' ? { ...x, output: e.output, ok: e.ok } : x));
  if (e.type === 'delta') {
    if (streaming.id) return xs.map((x) => (x.id === streaming.id && x.role === 'assistant' ? { ...x, text: x.text + e.text } : x));
    streaming.id = nid();
    return [...xs, { id: streaming.id, role: 'assistant', text: e.text }];
  }
  if (e.type === 'text') return [...xs, { id: nid(), role: 'assistant', text: e.text }];
  if (e.type === 'error') return [...xs, { id: nid(), role: 'error', text: e.message }];
  return xs;
}

let seq = 0;
const nid = () => `m${++seq}`;

const SUGGESTIONS = [
  'What is in this workspace?',
  'Draft a win-back segment for people who have not ordered in 90 days',
  'Why did the last AI decisions take their fallback?',
];

export function CopilotDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useWorkspace();
  const [items, setItems] = useState<Item[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dialog, confirm] = useConfirm();
  const end = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message whenever the list changes, which the body does not read
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [items]);

  const past = useApi(() => api.call('copilot.conversations', {}), [], { skip: !open });
  const loadPast = () => void past.reload();

  async function openConversation(id: string) {
    if (busy) return;
    setError(null);
    try {
      const c = await api.call('copilot.conversation', { id });
      const streaming = { id: null as string | null };
      setItems((c.events as Event[]).reduce<Item[]>((xs, e) => apply(xs, e, streaming), []));
      setConversationId(c.id);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setInput('');
    setBusy(true);
    setError(null);
    setItems((xs) => [...xs, { id: nid(), role: 'user', text }]);
    const streaming = { id: null as string | null };
    const on = (e: Event) => {
      if (e.type === 'conversation') setConversationId(e.id);
      else if (e.type === 'done') {
        setTokens((t) => t + e.usage.inputTokens + e.usage.outputTokens);
        loadPast();
      } else setItems((xs) => apply(xs, e, streaming));
    };
    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId }),
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

  async function remove(id: string, title: string) {
    const ok = await confirm({
      title: `Delete “${title}”?`,
      body: 'The conversation and everything said in it is removed. This cannot be undone.',
      confirmLabel: 'Delete conversation',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.call('copilot.deleteConversation', { id });
      loadPast();
      if (id === conversationId) {
        setItems([]);
        setConversationId(undefined);
      }
    } catch (e) {
      setError(errText(e));
    }
  }

  const conversations = past.data?.conversations ?? [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title="Copilot"
      meta="Runs as an agent with your permissions; it drafts, you approve."
      actions={
        items.length > 0 ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setItems([]);
              setConversationId(undefined);
              setError(null);
            }}
          >
            New chat
          </Button>
        ) : undefined
      }
    >
      {dialog}
      <div className="flex h-full min-h-0 flex-col">
        {past.error && (
          <div className="border-b border-line px-5 py-2">
            <Alert tone="bad" title="Couldn't load earlier conversations">
              {past.error}
            </Alert>
          </div>
        )}
        {conversations.length > 0 && (
          <details className="border-b border-line">
            <summary className="cursor-pointer px-5 py-2 text-[12px] font-medium text-muted hover:text-fg">
              Earlier conversations ({conversations.length})
            </summary>
            <ul className="max-h-[220px] divide-y divide-line overflow-y-auto">
              {conversations.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-5 py-1.5 text-[13px]">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    aria-current={c.id === conversationId ? 'true' : undefined}
                    onClick={() => void openConversation(c.id)}
                  >
                    {c.title}
                  </button>
                  <span className="shrink-0 text-[11px] text-muted">{timeAgo(c.updatedAt)}</span>
                  <IconButton
                    label={`Delete conversation ${c.title}`}
                    icon={<Trash2 size={14} />}
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(c.id, c.title)}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-[13px]">
          {error && (
            <Alert tone="bad" title="The copilot could not run">
              {error}
            </Alert>
          )}
          {!items.length && !error && (
            <div className="space-y-3 text-muted">
              <EmptyState compact title="Ask about the workspace or give it a task" icon={<Wrench size={16} />}>
                The copilot uses the same tools an external agent gets, acting for you: it can read, draft, simulate and request publishing.
                It cannot send, approve, erase people or change settings, and everything it does is in the audit log.
              </EmptyState>
              {can('artifacts:read') ? (
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} variant="secondary" size="sm" onClick={() => void ask(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-muted">The copilot needs the artifacts:read permission.</p>
              )}
            </div>
          )}
          {items.map((x) =>
            x.role === 'tool' ? (
              <details key={x.id} className="rounded-md border border-line bg-surface-2">
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px]">
                  <Wrench size={13} className="text-muted" aria-hidden />
                  <Tag>{x.name}</Tag>
                  {x.ok === undefined ? (
                    <Loader2 size={13} className="animate-spin text-muted" aria-label="Running" />
                  ) : (
                    !x.ok && <StatusPill tone="bad">Failed</StatusPill>
                  )}
                  <ChevronRight size={13} className="ml-auto text-muted" aria-hidden />
                </summary>
                <div className="space-y-2 p-2">
                  <JsonView label="Input" value={x.input} maxHeight={200} />
                  {x.output !== undefined && <JsonView label="Output" value={x.output} maxHeight={240} />}
                </div>
              </details>
            ) : x.role === 'error' ? (
              <Alert key={x.id} tone="bad" title="The copilot stopped">
                {x.text}
              </Alert>
            ) : (
              <div
                key={x.id}
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 ${x.role === 'user' ? 'ml-auto bg-accent-soft' : 'bg-surface-2'}`}
              >
                {x.text}
              </div>
            ),
          )}
          {busy && <Loader2 size={16} className="animate-spin text-muted" aria-label="Working" />}
          <div ref={end} />
        </div>
        <div className="space-y-2 border-t border-line px-5 py-3">
          <Textarea
            rows={2}
            value={input}
            placeholder="Ask or give a task"
            aria-label="Message to the copilot"
            disabled={!can('artifacts:read')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted" aria-live="polite">
              {tokens > 0 ? `${tokens.toLocaleString()} tokens used in this chat` : 'Enter sends, Shift+Enter starts a new line.'}
            </p>
            <Button
              variant="primary"
              icon={<Send size={14} />}
              disabled={busy || !input.trim() || !can('artifacts:read')}
              onClick={() => void ask(input)}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
