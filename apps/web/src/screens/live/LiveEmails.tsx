import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Mail, Plus, Server } from 'lucide-react';
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

function Providers({ onError }: { onError: (m: string) => void }) {
  const [data, setData] = useState<Out<'emailProviders.list'> | null>(null);
  const [form, setForm] = useState({ name: 'SMTP relay', adapter: 'smtp', config: SMTP_EXAMPLE, secrets: '{ "password": "" }', fromEmail: '', fromName: '' });
  const [webhook, setWebhook] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api.call('emailProviders.list', {}));
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  return (
    <Card title="E-mail providers" action={<Server size={14} className="text-muted" />}>
      <ul className="divide-y divide-line text-[13px]">
        {data?.providers.map((p) => (
          <li key={p.id} className="flex items-center gap-2 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{p.name}</span>
              <span className="text-[11px] text-muted">
                {p.adapter} · {p.fromEmail} · {p.useFor.join(', ') || 'not used'}
              </span>
            </span>
            <Pill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'enabled' : 'off'}</Pill>
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
              useFor: ['transactional', 'marketing'],
            });
            setWebhook(`${location.origin}${r.webhookPath}`);
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
        </div>
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
        <p className="border-t border-line px-4 py-2.5 text-[12px]">
          Delivery events webhook (shown once): <span className="break-all font-mono">{webhook}</span>
        </p>
      )}
    </Card>
  );
}
