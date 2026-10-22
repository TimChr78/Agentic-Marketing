import { useCallback, useEffect, useState } from 'react';
import { Cable, KeyRound, Plus, RotateCcw, Send, Trash2, Webhook } from 'lucide-react';
import { Button, Card, Pill, cx, inputCls, timeAgo } from '../../components/ui';
import { api, errText, type Out } from '../liveApi';

// Integrations on the real API: API tokens for scripts and n8n, outbound webhook endpoints with
// their delivery log, and connections (inbound webhooks and journey actions).

const SCOPES = ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'profiles:read', 'profiles:write', 'messages:send', 'audit:read'] as const;
const statusTone = { done: 'good', pending: 'neutral', running: 'neutral', failed: 'bad', dead: 'bad' } as const;

/** Shown once after creating something with a secret. */
function Once({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  return (
    <div className="m-3 rounded-md border border-agent/40 bg-agent-soft p-3 text-[13px]">
      <p className="font-medium">{label}: copy it now, it is not shown again.</p>
      <code className="mt-1 block break-all font-mono text-[12px]">{value}</code>
      <Button variant="ghost" className="mt-2" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}

export function LiveIntegrations({ canAdmin, permissions, onError }: { canAdmin: boolean; permissions: string[]; onError: (m: string) => void }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Endpoints canAdmin={canAdmin} onError={onError} />
        <Tokens permissions={permissions} onError={onError} />
      </div>
      <Connections canAdmin={canAdmin} onError={onError} />
    </div>
  );
}

function Tokens({ permissions, onError }: { permissions: string[]; onError: (m: string) => void }) {
  const [list, setList] = useState<Out<'apiTokens.list'>['tokens']>([]);
  const [name, setName] = useState('n8n');
  const [scopes, setScopes] = useState<string[]>(['artifacts:read']);
  const [shown, setShown] = useState('');
  const load = useCallback(async () => {
    try {
      setList((await api.call('apiTokens.list', {})).tokens);
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  return (
    <Card title="API tokens" action={<Pill>{list.filter((x) => !x.revoked).length}</Pill>}>
      {shown && <Once label="Token" value={shown} onClose={() => setShown('')} />}
      <form
        className="space-y-2 border-b border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.call('apiTokens.create', { name, scopes: scopes as (typeof SCOPES)[number][] });
            setShown(r.token);
            await load();
          } catch (err) {
            onError(errText(err));
          }
        }}
      >
        <div className="flex gap-2">
          <input className={cx(inputCls, 'min-w-0 flex-1')} value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" />
          <Button variant="primary">
            <KeyRound size={14} /> Create
          </Button>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
          {SCOPES.filter((s) => permissions.includes(s)).map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) => setScopes((xs) => (e.target.checked ? [...xs, s] : xs.filter((x) => x !== s)))}
              />
              {s}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted">Use as Authorization: Bearer … on /v1/&lt;command&gt; or /mcp. It acts as an agent for you, with these scopes.</p>
      </form>
      <ul className="divide-y divide-line">
        {list.map((x) => (
          <li key={x.id} className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{x.name}</span> <span className="font-mono text-[11px] text-muted">{x.tokenHint}</span>
              <span className="block text-[11px] text-muted">
                {x.scopes.join(', ')} · {x.lastUsedAt ? `used ${timeAgo(Date.parse(x.lastUsedAt))}` : 'never used'}
              </span>
            </span>
            {x.revoked ? (
              <Pill tone="bad">revoked</Pill>
            ) : (
              <Button
                variant="ghost"
                aria-label={`Revoke ${x.name}`}
                onClick={async () => {
                  try {
                    await api.call('apiTokens.revoke', { id: x.id });
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
      </ul>
    </Card>
  );
}

function Endpoints({ canAdmin, onError }: { canAdmin: boolean; onError: (m: string) => void }) {
  const [list, setList] = useState<Out<'webhooks.list'>['endpoints']>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Out<'deliveries.list'>['deliveries']>([]);
  const [form, setForm] = useState({ name: 'n8n', url: 'https://', events: 'Order Completed, Segment Entered' });
  const [shown, setShown] = useState('');
  const load = useCallback(async () => {
    try {
      setList((await api.call('webhooks.list', {})).endpoints);
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  const loadDeliveries = useCallback(
    async (id: string) => {
      try {
        setDeliveries((await api.call('deliveries.list', { targetId: id, limit: 20 })).deliveries);
      } catch (e) {
        onError(errText(e));
      }
    },
    [onError],
  );
  useEffect(() => void load(), [load]);
  return (
    <Card title="Webhook endpoints" action={<Pill>{list.length}</Pill>}>
      {shown && <Once label="Signing secret" value={shown} onClose={() => setShown('')} />}
      {canAdmin && (
        <form
          className="grid gap-2 border-b border-line p-3 sm:grid-cols-[1fr_2fr]"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.call('webhooks.create', {
                name: form.name,
                url: form.url,
                events: form.events
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              });
              setShown(r.secret);
              onError('');
              await load();
            } catch (err) {
              onError(errText(err));
            }
          }}
        >
          <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Endpoint name" />
          <input className={inputCls} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} aria-label="Endpoint URL" />
          <input
            className={cx(inputCls, 'sm:col-span-2')}
            value={form.events}
            onChange={(e) => setForm({ ...form, events: e.target.value })}
            aria-label="Events (comma-separated, * for all)"
          />
          <div className="flex items-center gap-2 sm:col-span-2">
            <p className="flex-1 text-[11px] text-muted">Signed with Standard Webhooks headers. Events: names, "identify", or * for all; leave empty for journey steps only.</p>
            <Button variant="primary">
              <Plus size={14} /> Add
            </Button>
          </div>
        </form>
      )}
      <ul className="divide-y divide-line">
        {list.map((x) => (
          <li key={x.id}>
            <button
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-surface-2"
              onClick={() => {
                setOpen(open === x.id ? null : x.id);
                if (open !== x.id) void loadDeliveries(x.id);
              }}
            >
              <Webhook size={15} className="text-muted" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{x.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {x.url} · {x.events.length ? x.events.join(', ') : 'journey steps only'}
                </span>
              </span>
              <Pill tone={x.enabled ? 'good' : 'neutral'}>{x.enabled ? 'on' : 'off'}</Pill>
            </button>
            {open === x.id && (
              <div className="border-t border-line bg-surface-2 px-4 py-2">
                <div className="mb-2 flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await api.call('webhooks.test', { id: x.id });
                        setTimeout(() => void loadDeliveries(x.id), 1500);
                      } catch (e) {
                        onError(errText(e));
                      }
                    }}
                  >
                    <Send size={14} /> Send test
                  </Button>
                  <Button variant="ghost" onClick={() => loadDeliveries(x.id)}>
                    Refresh
                  </Button>
                </div>
                <ul className="space-y-1 text-[12px]">
                  {deliveries.map((d) => (
                    <li key={d.id} className="flex items-center gap-2">
                      <Pill tone={statusTone[d.status]}>{d.status}</Pill>
                      <span className="font-mono">{(d.payload as { type?: string }).type}</span>
                      <span className="text-muted">
                        {d.attempts}× {d.statusCode ?? ''} {d.error ? `· ${d.error.slice(0, 60)}` : ''}
                      </span>
                      <span className="ml-auto text-muted">{timeAgo(Date.parse(d.createdAt))}</span>
                      {(d.status === 'dead' || d.status === 'failed') && canAdmin && (
                        <Button
                          variant="ghost"
                          aria-label="Retry"
                          onClick={async () => {
                            await api.call('deliveries.retry', { id: d.id }).catch((e) => onError(errText(e)));
                            setTimeout(() => void loadDeliveries(x.id), 1500);
                          }}
                        >
                          <RotateCcw size={13} />
                        </Button>
                      )}
                    </li>
                  ))}
                  {!deliveries.length && <li className="text-muted">No deliveries yet.</li>}
                </ul>
              </div>
            )}
          </li>
        ))}
        {!list.length && <li className="px-4 py-4 text-[13px] text-muted">No endpoints. Add one to send events to n8n, a CRM or your own service.</li>}
      </ul>
    </Card>
  );
}

function Connections({ canAdmin, onError }: { canAdmin: boolean; onError: (m: string) => void }) {
  const [catalog, setCatalog] = useState<Out<'connectors.list'>['connectors']>([]);
  const [list, setList] = useState<Out<'connections.list'>['connections']>([]);
  const [connector, setConnector] = useState('shopify');
  const [name, setName] = useState('');
  const [settings, setSettings] = useState('{}');
  const [secrets, setSecrets] = useState('{}');
  const [shown, setShown] = useState('');
  const load = useCallback(async () => {
    try {
      setCatalog((await api.call('connectors.list', {})).connectors);
      setList((await api.call('connections.list', {})).connections);
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  const c = catalog.find((x) => x.id === connector);
  const keys = (s: unknown) => Object.keys((s as { properties?: object })?.properties ?? {});

  return (
    <Card title="Connections" action={<Pill>{list.length}</Pill>}>
      {shown && <Once label="Inbound webhook URL" value={`${location.origin}${shown}`} onClose={() => setShown('')} />}
      {canAdmin && (
        <form
          className="space-y-2 border-b border-line p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.call('connections.create', {
                connector,
                name: name || c?.label || connector,
                settings: JSON.parse(settings),
                secrets: JSON.parse(secrets),
              });
              if (r.inboundPath) setShown(r.inboundPath);
              setSecrets('{}');
              onError('');
              await load();
            } catch (err) {
              onError(err instanceof SyntaxError ? 'Settings and secrets must be JSON.' : errText(err));
            }
          }}
        >
          <div className="flex gap-2">
            <div className="w-40 shrink-0">
              <select className={inputCls} value={connector} onChange={(e) => setConnector(e.target.value)} aria-label="Connector">
                {catalog.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
            <input className={cx(inputCls, 'min-w-0 flex-1')} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Connection name" />
          </div>
          {c && (
            <p className="text-[12px] text-muted">
              {c.description} {c.inbound ? 'Receives webhooks.' : ''} {c.actions.length ? `Actions: ${c.actions.map((a) => a.name).join(', ')}.` : ''}
            </p>
          )}
          <label className="block text-[12px] text-muted">
            Settings (JSON{c && keys(c.settings).length ? `: ${keys(c.settings).join(', ')}` : ''})
            <textarea className={cx(inputCls, 'h-16 font-mono text-[12px]')} value={settings} onChange={(e) => setSettings(e.target.value)} />
          </label>
          <label className="block text-[12px] text-muted">
            Secrets (JSON, write-only{c && keys(c.secrets).length ? `: ${keys(c.secrets).join(', ')}` : ''})
            <textarea className={cx(inputCls, 'h-16 font-mono text-[12px]')} value={secrets} onChange={(e) => setSecrets(e.target.value)} />
          </label>
          <div className="flex justify-end">
            <Button variant="primary">
              <Plus size={14} /> Connect
            </Button>
          </div>
        </form>
      )}
      <ul className="divide-y divide-line">
        {list.map((x) => (
          <li key={x.id} className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
            <Cable size={15} className="text-muted" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{x.name}</span>
              <span className="block text-[11px] text-muted">
                {x.connector} · <span className="font-mono">{x.id}</span>
                {x.inbound ? ' · receives webhooks' : ''}
              </span>
            </span>
            {canAdmin && (
              <Button
                variant="ghost"
                aria-label={`Delete ${x.name}`}
                onClick={async () => {
                  if (!confirm(`Delete ${x.name}? Its inbound URL stops working and journey steps using it take their error edge.`)) return;
                  try {
                    await api.call('connections.delete', { id: x.id });
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
        {!list.length && <li className="px-4 py-4 text-[13px] text-muted">No connections yet.</li>}
      </ul>
    </Card>
  );
}
