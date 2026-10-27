import { useState } from 'react';
import { BarChart3, Bot, Copy, Mail, Plug, Webhook } from 'lucide-react';
import { useStore } from '../mock/store';
import { commands } from '../api/commands';
import { Button, Card, PageHeader, Pill, cx, timeAgo } from '../components/ui';
import { pageWidth } from '../ui';

const effectTone = { read: 'neutral', write: 'accent', publish: 'agent', send: 'bad' } as const;

export function Setup() {
  const { audit } = useStore();
  const [openTool, setOpenTool] = useState<string | null>(null);
  const endpoint = 'https://marketing.homelab.example/mcp';

  return (
    <div className={pageWidth('reading')}>
      <PageHeader eyebrow="Workspace setup" title="Channels & MCP" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Channels & destinations">
          <ul className="divide-y divide-line text-[13px]">
            {[
              { icon: Mail, name: 'E-mail · SMTP relay', detail: 'smtp.relay.homelab.example:587 · STARTTLS · bounce mailbox via IMAP', status: 'Connected', tone: 'good' as const },
              { icon: BarChart3, name: 'Umami (self-hosted)', detail: 'Forward page views and custom events · website id for martechsignal.com', status: 'Destination', tone: 'accent' as const },
              { icon: Webhook, name: 'Outbound webhooks', detail: 'HMAC-signed, retries with backoff · phase 2', status: 'Planned', tone: 'neutral' as const },
              { icon: Plug, name: 'Shopify · Salesforce', detail: 'First-party connectors after v1', status: 'Later', tone: 'neutral' as const },
            ].map((c) => (
              <li key={c.name} className="flex items-start gap-3 px-4 py-3">
                <c.icon size={16} className="mt-0.5 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.name}</div>
                  <div className="text-[12px] text-muted">{c.detail}</div>
                </div>
                <Pill tone={c.tone}>{c.status}</Pill>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="LLM providers (bring your own key)">
          <ul className="divide-y divide-line text-[13px]">
            <li className="flex items-start gap-3 px-4 py-3">
              <Bot size={16} className="mt-0.5 text-agent" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Anthropic-compatible</div>
                <div className="font-mono text-[12px] text-muted">https://api.anthropic.com · claude-opus-5-5</div>
                <div className="mt-1 text-[12px] text-muted">Used by AI journey steps and the copilot. Key stored encrypted, never returned by the API.</div>
              </div>
              <Pill tone="agent">default</Pill>
            </li>
            <li className="flex items-start gap-3 px-4 py-3">
              <Bot size={16} className="mt-0.5 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">OpenAI-compatible</div>
                <div className="font-mono text-[12px] text-muted">any /v1/chat/completions endpoint (OpenAI, Mistral, Ollama, vLLM…)</div>
              </div>
              <Pill>optional</Pill>
            </li>
          </ul>
          <div className="border-t border-line px-4 py-2.5 text-[12px] text-muted">
            AI context is minimised: only attributes marked “AI visible” are sent, identifiers are pseudonymised, purpose <code className="font-mono">ai_processing</code> is checked first.
          </div>
        </Card>

        <Card title="MCP server" className="lg:col-span-2">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-[13px]">
            <span className="text-muted">Endpoint</span>
            <code className="font-mono text-[12px]">{endpoint}</code>
            <Button
              variant="ghost"
              onClick={() =>
                navigator.clipboard?.writeText(endpoint).then(
                  () => useStore.getState().toast('Copied MCP endpoint', 'good'),
                  () => useStore.getState().toast('Copy failed, select the text instead', 'bad'),
                )
              }
            >
              <Copy size={13} /> Copy
            </Button>
            <span className="text-muted">Streamable HTTP · OAuth 2.1 with dynamic client registration · {commands.length} tools</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wider text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-semibold">Tool</th>
                  <th className="px-4 py-2 font-semibold">Effect</th>
                  <th className="px-4 py-2 font-semibold">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {commands.map((c) => (
                  <tr key={c.name} className="cursor-pointer align-top hover:bg-surface-2" onClick={() => setOpenTool(openTool === c.name ? null : c.name)}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[12px] font-medium">{c.name}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        <Pill tone={effectTone[c.effect]}>{c.effect}</Pill>
                        {c.humansOnly && <Pill>humans only</Pill>}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-muted">
                      {c.description}
                      {openTool === c.name && <pre className="mt-2 overflow-x-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11px] text-fg">{JSON.stringify(c.input, null, 2)}</pre>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Audit log" className="lg:col-span-2" action={<span className="text-[12px] text-muted">Every command, from the UI, the copilot or an MCP client</span>}>
          <ul className="max-h-[320px] divide-y divide-line overflow-y-auto text-[12px]">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-1.5">
                <span className="num w-[64px] text-muted">{timeAgo(a.at)}</span>
                <Pill tone={a.principal.type === 'agent' ? 'agent' : 'neutral'}>{a.principal.name}</Pill>
                <code className={cx('font-mono', !a.ok && 'text-bad')}>{a.command}</code>
                <span className="min-w-0 flex-1 truncate text-muted">{a.summary}</span>
              </li>
            ))}
            {!audit.length && <li className="px-4 py-3 text-muted">Nothing yet. Use the app or the copilot and the commands appear here.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
