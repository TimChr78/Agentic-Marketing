import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Copy, Gauge, Mail, MessageSquare, Plus, RefreshCw, Server } from 'lucide-react';
import { Button, Card, Pill, cx, inputBase, inputCls, timeAgo } from '../../components/ui';
import { api, errText, type Out } from '../liveApi';

const LiveEmailEditor = lazy(() => import('./LiveEmailEditor'));

const STARTER = `<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="20px">Hej {{ profile.firstName | default: "there" }}</mj-text>
        <mj-text>Write your message here.</mj-text>
        <mj-button href="https://example.com">Call to action</mj-button>
        <mj-text font-size="11px"><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

const statusTone = { queued: 'neutral', sending: 'neutral', sent: 'accent', delivered: 'good', suppressed: 'warn', failed: 'bad', bounced: 'bad', complained: 'bad' } as const;
const trackingTone = { forced: 'bad', configurable: 'warn', none: 'good' } as const;

export function LiveEmails({ canAdmin, onError }: { canAdmin: boolean; onError: (m: string) => void }) {
  const [list, setList] = useState<Out<'artifacts.list'>['artifacts']>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [messages, setMessages] = useState<Out<'messages.list'>['messages']>([]);
  const [stats, setStats] = useState<Out<'messages.stats'> | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await api.call('artifacts.list', {})).artifacts.filter((a) => a.type === 'email_template'));
      setMessages((await api.call('messages.list', { limit: 20 }).catch(() => ({ messages: [] }))).messages);
      setStats(await api.call('messages.stats', { days: 30 }).catch(() => null));
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  if (open)
    return (
      <Suspense fallback={<p className="text-muted">Loading the e-mail editor…</p>}>
        <LiveEmailEditor
          id={open}
          onError={onError}
          onBack={() => {
            setOpen(null);
            void load();
          }}
        />
      </Suspense>
    );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card title="E-mail templates" action={<Pill>{list.length}</Pill>}>
          <form
            className="flex gap-2 border-b border-line p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api.call('artifacts.create', {
                  type: 'email_template',
                  name: name || 'New e-mail',
                  content: { purpose: 'marketing_email', subject: 'Hej {{ profile.firstName | default: "there" }}', mjml: STARTER, sampleData: { profile: { firstName: 'Ada' } } },
                });
                setName('');
                setOpen(r.artifactId);
              } catch (err) {
                onError(errText(err));
              }
            }}
          >
            <input className={cx(inputCls, 'min-w-0 flex-1')} placeholder="New template name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New template name" />
            <Button variant="primary">
              <Plus size={14} /> Create
            </Button>
          </form>
          <ul className="divide-y divide-line">
            {list.map((t) => (
              <li key={t.id}>
                <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2" onClick={() => setOpen(t.id)}>
                  <Mail size={15} className="text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.name}</span>
                    <span className="text-[11px] text-muted">
                      v{t.latestVersion}
                      {t.publishedVersion ? ` · live v${t.publishedVersion}` : ''} · {timeAgo(Date.parse(t.updatedAt))}
                    </span>
                  </span>
                  <Pill tone={t.publishedVersion ? 'good' : 'neutral'}>{t.publishedVersion ? 'live' : t.latestState.replace('_', ' ')}</Pill>
                </button>
              </li>
            ))}
            {!list.length && <li className="px-4 py-4 text-[13px] text-muted">No templates yet.</li>}
          </ul>
        </Card>
        {canAdmin && <Providers onError={onError} />}
        <Deliverability onError={onError} />
        {canAdmin && <SmsProviders onError={onError} />}
      </div>
      <Card title="Recent messages" action={<Pill>{messages.length}</Pill>}>
        {stats && (
          <div className="num grid grid-cols-3 gap-2 border-b border-line px-4 py-3 text-[12px] sm:grid-cols-6">
            {(['sent', 'delivered', 'clicked', 'bounced', 'unsubscribed', 'suppressed'] as const).map((k) => (
              <div key={k}>
                <div className="text-[11px] text-muted">{k}</div>
                <div className="font-semibold">
                  {stats.counts[k] ?? 0}
                  {k !== 'sent' && k !== 'suppressed' && stats.rates[k] !== null && <span className="ml-1 text-[11px] font-normal text-muted">{stats.rates[k]}%</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        <ul className="divide-y divide-line text-[13px]">
          {messages.map((m) => (
            <li key={m.id} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{m.profileId?.slice(0, 14)}…</span>
                <Pill tone={statusTone[m.status]}>{m.status}</Pill>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted">
                {list.find((t) => t.id === m.templateId)?.name ?? m.templateId} · {m.purpose} · {timeAgo(Date.parse(m.createdAt))}
              </div>
              {m.reason && <div className="mt-0.5 text-[12px] text-warn">{m.reason}</div>}
              {m.events.length > 0 && <div className="mt-0.5 text-[11px] text-muted">{m.events.map((e) => e.type).join(' → ')}</div>}
            </li>
          ))}
          {!messages.length && <li className="px-4 py-4 text-muted">Nothing sent yet.</li>}
        </ul>
      </Card>
    </div>
  );
}

const SMTP_EXAMPLE = '{ "host": "smtp.example.com", "port": 587, "user": "apikey", "events": "none" }';
const INITIAL_PROVIDER_FORM = {
  name: 'SMTP relay',
  adapter: 'smtp',
  config: SMTP_EXAMPLE,
  secrets: '{ "password": "" }',
  fromEmail: '',
  fromName: '',
  replyTo: '',
};

function Providers({ onError }: { onError: (m: string) => void }) {
  const [data, setData] = useState<Out<'emailProviders.list'> | null>(null);
  const [form, setForm] = useState(INITIAL_PROVIDER_FORM);
  const [webhook, setWebhook] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api.call('emailProviders.list', {}));
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  const selected = data?.adapters.find((a) => a.id === form.adapter);

  return (
    <Card title="E-mail providers" action={<Server size={14} className="text-muted" />}>
      {!!data?.warnings.length && (
        <div className="border-b border-warn/40 bg-warn-soft px-4 py-2.5 text-[12px] text-warn">
          {data.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      <ul className="divide-y divide-line text-[13px]">
        {data?.providers.map((p) => (
          <li key={p.id} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{p.name}</span>
                <span className="text-[11px] text-muted">
                  {p.adapter} · {p.fromEmail} · {p.useFor.join(', ') || 'not used'}
                  {p.replyTo ? ` · reply-to ${p.replyTo}` : ''}
                </span>
              </span>
              <span title={p.trackingNote}>
                <Pill tone={trackingTone[p.tracking]}>Provider tracking: {p.tracking}</Pill>
              </span>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Create a new webhook URL for ${p.name}? The old URL stops working immediately.`)) return;
                  try {
                    const r = await api.call('emailProviders.rotateWebhook', { id: p.id });
                    setWebhook(r.webhookUrl);
                  } catch (e) {
                    onError(errText(e));
                  }
                }}
              >
                <RefreshCw size={14} /> New webhook URL
              </Button>
              <Pill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'enabled' : 'off'}</Pill>
            </div>
            <p className="mt-1 text-[11px] text-muted">{p.trackingNote}</p>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-2 border-t border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.call('emailProviders.create', {
              name: form.name,
              adapter: form.adapter as 'smtp',
              config: JSON.parse(form.config || '{}'),
              secrets: JSON.parse(form.secrets || '{}'),
              fromEmail: form.fromEmail,
              fromName: form.fromName,
              ...(form.replyTo.trim() ? { replyTo: form.replyTo.trim() } : {}),
              useFor: ['transactional', 'marketing'],
            });
            setWebhook(r.webhookUrl);
            setForm(INITIAL_PROVIDER_FORM);
            await load();
          } catch (err) {
            onError(err instanceof SyntaxError ? 'Settings and credentials must be JSON.' : errText(err));
          }
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Provider name" />
          <select className={inputBase} value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value })} aria-label="Adapter">
            {data?.adapters.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <input className={inputCls} placeholder="From address" value={form.fromEmail} onChange={(e) => setForm({ ...form, fromEmail: e.target.value })} aria-label="From address" />
          <input className={inputCls} placeholder="From name" value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} aria-label="From name" />
          <input
            className={inputCls}
            placeholder="Reply-to address (optional)"
            value={form.replyTo}
            onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
            aria-label="Reply-to address"
          />
        </div>
        {selected && (
          <p className="text-[11px] text-muted">
            Provider tracking: <span className="font-semibold">{selected.tracking}</span> — {selected.trackingNote}
          </p>
        )}
        <textarea className={cx(inputCls, 'h-16 font-mono text-[12px]')} value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} aria-label="Settings (JSON)" />
        <textarea className={cx(inputCls, 'h-12 font-mono text-[12px]')} value={form.secrets} onChange={(e) => setForm({ ...form, secrets: e.target.value })} aria-label="Credentials (JSON, write-only)" />
        <div className="flex items-center gap-2">
          <Button variant="primary">
            <Plus size={14} /> Add provider
          </Button>
          <span className="text-[11px] text-muted">Used for transactional and marketing e-mail. Credentials are stored encrypted and never shown again.</span>
        </div>
      </form>
      {webhook && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 text-[12px]">
          <span>Delivery events webhook (shown once):</span>
          <span className="break-all font-mono">{webhook}</span>
          <Button
            variant="ghost"
            onClick={() =>
              navigator.clipboard?.writeText(webhook).catch(() => onError('Copy failed, select the text instead.'))
            }
          >
            <Copy size={13} /> Copy
          </Button>
        </div>
      )}
    </Card>
  );
}

const rateTone = { ok: 'good', warn: 'warn', paused: 'bad' } as const;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function Deliverability({ onError }: { onError: (m: string) => void }) {
  const [h, setH] = useState<Out<'deliverability.health'> | null>(null);
  useEffect(() => {
    api
      .call('deliverability.health', {})
      .then(setH)
      .catch((e) => onError(errText(e)));
  }, [onError]);
  if (!h) return null;
  const rows = [
    ['E-mail · marketing', h.email.marketing],
    ['E-mail · transactional', h.email.transactional],
    ['SMS · marketing', h.sms.marketing],
    ['SMS · transactional', h.sms.transactional],
  ] as const;
  return (
    <Card title={`Deliverability · last ${h.windowDays} days`} action={<Gauge size={14} className="text-muted" />}>
      <ul className="divide-y divide-line text-[13px]">
        {rows.map(([label, r]) => (
          <li key={label} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-medium">{label}</span>
              <Pill tone={rateTone[r.status]}>{r.status}</Pill>
            </div>
            <div className="num text-[11px] text-muted">
              {r.sent} sent · bounces {pct(r.bounceRate)} · complaints {pct(r.complaintRate)}
            </div>
            {r.reason && <div className="mt-0.5 text-[12px] text-warn">{r.reason}</div>}
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-2.5 text-[11px] text-muted">
        Marketing messages pause at {pct(h.thresholds.complaintStop)} complaints or {pct(h.thresholds.bounceStop)} bounces (after{' '}
        {h.thresholds.minVolume} messages){h.autoPause ? '' : ' — auto-pause is off'}. Caps and quiet hours: the delivery policy artifact.
      </p>
    </Card>
  );
}

function SmsProviders({ onError }: { onError: (m: string) => void }) {
  const [data, setData] = useState<Out<'smsProviders.list'> | null>(null);
  const [form, setForm] = useState({
    name: 'Twilio',
    adapter: 'twilio',
    config: '{ "accountSid": "AC…" }',
    secrets: '{ "authToken": "" }',
    sender: '',
    price: '0.08',
    budget: '',
  });
  const load = useCallback(async () => {
    try {
      setData(await api.call('smsProviders.list', {}));
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  return (
    <Card title="SMS providers" action={<MessageSquare size={14} className="text-muted" />}>
      <ul className="divide-y divide-line text-[13px]">
        {data?.providers.map((p) => (
          <li key={p.id} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-medium">{p.name}</span>
              <Pill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'enabled' : 'off'}</Pill>
            </div>
            <div className="text-[11px] text-muted">
              {p.adapter} · {p.sender} · {p.useFor.join(', ') || 'not used'} · {p.billing.pricePerSegment} {p.billing.currency}/segment
              {p.billing.monthlyBudget !== undefined ? ` · budget ${p.billing.monthlyBudget}/month` : ''}
            </div>
            <div className="mt-0.5 break-all font-mono text-[11px] text-muted">Incoming messages: {location.origin + p.webhookPath}/inbound</div>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-2 border-t border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.call('smsProviders.create', {
              name: form.name,
              adapter: form.adapter as 'twilio',
              config: JSON.parse(form.config || '{}'),
              secrets: JSON.parse(form.secrets || '{}'),
              sender: form.sender,
              useFor: ['transactional', 'marketing'],
              billing: { pricePerSegment: Number(form.price) || 0, ...(form.budget ? { monthlyBudget: Number(form.budget) } : {}) },
            });
            await load();
          } catch (err) {
            onError(err instanceof SyntaxError ? 'Settings and credentials must be JSON.' : errText(err));
          }
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Provider name" />
          <select className={inputBase} value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value })} aria-label="Adapter">
            <option value="twilio">Twilio</option>
            <option value="log">Development outbox</option>
          </select>
          <input className={inputCls} placeholder="Sender (+4512345678 or name)" value={form.sender} onChange={(e) => setForm({ ...form, sender: e.target.value })} aria-label="Sender" />
          <div className="flex gap-2">
            <input className={inputCls} placeholder="Price/segment" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} aria-label="Price per segment" />
            <input className={inputCls} placeholder="Monthly budget" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} aria-label="Monthly budget" />
          </div>
        </div>
        <textarea className={cx(inputCls, 'h-12 font-mono text-[12px]')} value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} aria-label="Settings (JSON)" />
        <textarea className={cx(inputCls, 'h-12 font-mono text-[12px]')} value={form.secrets} onChange={(e) => setForm({ ...form, secrets: e.target.value })} aria-label="Credentials (JSON, write-only)" />
        <div className="flex items-center gap-2">
          <Button variant="primary">
            <Plus size={14} /> Add SMS provider
          </Button>
          <span className="text-[11px] text-muted">Set the incoming-messages URL on the number so STOP and HELP work.</span>
        </div>
      </form>
    </Card>
  );
}
