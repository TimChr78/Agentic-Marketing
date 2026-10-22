import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, Plus, RefreshCw, Trash2, User, UserX } from 'lucide-react';
import { Button, Card, Mono, Pill, cx, inputCls, timeAgo } from '../components/ui';
import { api, errText, type Out } from './liveApi';

// Phase 1: the data platform through the real API. Sources and their snippet, people as the
// identity resolver sees them, their consent and events, and the two data subject requests.

type Source = Out<'sources.list'>['sources'][number];
type ProfileRow = Out<'profiles.list'>['profiles'][number];
type Profile = Out<'profiles.get'>;
type Ev = Out<'profiles.events'>['events'][number];

const consentTone = { granted: 'good', denied: 'neutral', withdrawn: 'warn', objected: 'bad' } as const;

export function LiveProfiles({ canAdmin, onError }: { canAdmin: boolean; onError: (m: string) => void }) {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfiles((await api.call('profiles.list', { limit: 100 })).profiles);
      onError('');
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void refresh(), [refresh]);

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        {canAdmin && <Sources onError={onError} />}
        <Card title="People" action={<Button variant="ghost" onClick={refresh} aria-label="Refresh"><RefreshCw size={14} /></Button>}>
          <ul className="max-h-[520px] divide-y divide-line overflow-y-auto">
            {profiles.map((p) => (
              <li key={p.id}>
                <button className={cx('flex w-full items-center gap-2.5 px-4 py-2.5 text-left', selected === p.id ? 'bg-surface-2' : 'hover:bg-surface-2')} onClick={() => setSelected(p.id)}>
                  <User size={15} className={p.known ? 'text-accent' : 'text-muted'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px]">{p.id.slice(0, 14)}…</span>
                    <span className="text-[11px] text-muted">
                      {Object.entries(p.traits).slice(0, 2).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || 'no traits'} · {timeAgo(Date.parse(p.lastSeen))}
                    </span>
                  </span>
                  <Pill tone={p.known ? 'accent' : 'neutral'}>{p.known ? 'known' : 'anonymous'}</Pill>
                </button>
              </li>
            ))}
            {!profiles.length && <li className="px-4 py-4 text-[13px] text-muted">No people yet. Add a website source and send a few events with the snippet.</li>}
          </ul>
        </Card>
      </div>
      {selected ? (
        <ProfileDetail
          key={selected}
          id={selected}
          onError={onError}
          onErased={() => {
            setSelected(null);
            void refresh();
          }}
        />
      ) : (
        <Card>
          <p className="p-5 text-[13px] text-muted">Select a person to see their profile, consent and events.</p>
        </Card>
      )}
    </div>
  );
}

function Sources({ onError }: { onError: (m: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [origin, setOrigin] = useState('');
  const [secret, setSecret] = useState('');
  const load = useCallback(async () => {
    try {
      setSources((await api.call('sources.list', {})).sources);
    } catch (e) {
      onError(errText(e));
    }
  }, [onError]);
  useEffect(() => void load(), [load]);

  const browser = sources.find((s) => s.kind === 'browser' && s.enabled);
  const snippet = browser
    ? `import { createAnalytics } from '@agentic-marketing/sdk-js';
const analytics = createAnalytics({ writeKey: '${browser.writeKey}', host: '${location.origin}' });
// From your consent banner:
analytics.setConsent({ analytics: true, marketing_email: false });
analytics.page();`
    : '';

  return (
    <Card title="Sources" action={<Pill>{sources.length}</Pill>}>
      <ul className="divide-y divide-line">
        {sources.map((s) => (
          <li key={s.id} className="px-4 py-2.5 text-[13px]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
              <Pill tone={s.kind === 'browser' ? 'accent' : 'neutral'}>{s.kind}</Pill>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted">
              {s.kind === 'browser' ? s.allowedOrigins.join(', ') : `key ${s.keyHint}`}
              {s.requiredPurpose ? ` · needs "${s.requiredPurpose}" consent` : ' · no consent gate'}
            </div>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.call('sources.create', { name: origin || 'Website', kind: 'browser', allowedOrigins: [origin || location.origin] });
            setOrigin('');
            await load();
          } catch (err) {
            onError(errText(err));
          }
        }}
      >
        <input className={cx(inputCls, 'min-w-0 flex-1')} placeholder={`Site origin, e.g. ${location.origin}`} value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label="Site origin" />
        <Button variant="primary">
          <Plus size={14} /> Website
        </Button>
        <Button
          type="button"
          title="Server source: the secret key is shown once"
          onClick={async () => {
            try {
              setSecret((await api.call('sources.create', { name: 'Server', kind: 'server' })).key);
              await load();
            } catch (err) {
              onError(errText(err));
            }
          }}
        >
          <KeyRound size={14} />
        </Button>
      </form>
      {secret && (
        <p className="border-t border-line px-4 py-2.5 text-[12px]">
          Server key, shown once: <Mono className="break-all">{secret}</Mono>
        </p>
      )}
      {snippet && <pre className="overflow-x-auto border-t border-line bg-surface-2 px-4 py-3 font-mono text-[11px] leading-relaxed">{snippet}</pre>}
    </Card>
  );
}

function ProfileDetail({ id, onError, onErased }: { id: string; onError: (m: string) => void; onErased: () => void }) {
  const [p, setP] = useState<Profile | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [profile, ev] = await Promise.all([api.call('profiles.get', { profileId: id }), api.call('profiles.events', { profileId: id, limit: 50 })]);
        setP(profile);
        setEvents(ev.events);
      } catch (e) {
        onError(errText(e));
      }
    })();
  }, [id, onError]);

  if (!p) return <Card><p className="p-5 text-[13px] text-muted">Loading…</p></Card>;

  const exportData = async () => {
    try {
      const data = await api.call('profiles.export', { profileId: p.id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${p.id}.json` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      onError(errText(e));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card
        title={<span className="font-mono text-[13px]">{p.id}</span>}
        action={
          <div className="flex gap-1.5">
            <Button variant="ghost" onClick={exportData} title="Access request: everything held about this person">
              <Download size={14} /> Export
            </Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              <UserX size={14} /> Erase
            </Button>
          </div>
        }
      >
        {confirming && (
          <form
            className="flex flex-wrap items-center gap-2 border-b border-line bg-bad-soft px-4 py-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.call('profiles.erase', { profileId: p.id, reason: reason || 'Erasure request' });
                onErased();
              } catch (err) {
                onError(errText(err));
              }
            }}
          >
            <span className="text-[13px] text-bad">Permanently erase this person, their events and consent records?</span>
            <input className={cx(inputCls, 'min-w-[200px] flex-1')} placeholder="Reason, e.g. request by e-mail" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
            <Button variant="danger">
              <Trash2 size={14} /> Erase
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </form>
        )}
        <dl className="grid gap-x-6 gap-y-1.5 px-4 py-3 text-[13px] sm:grid-cols-[140px_minmax(0,1fr)]">
          {Object.entries({ ...p.personal, ...p.traits }).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">
                {k} {k in p.personal && <Pill tone="warn">personal</Pill>}
              </dt>
              <dd className="min-w-0 truncate">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
          <dt className="text-muted">first / last seen</dt>
          <dd>
            {new Date(p.firstSeen).toLocaleString()} / {timeAgo(Date.parse(p.lastSeen))}
          </dd>
        </dl>
        <div className="border-t border-line px-4 py-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Identifiers{p.mergedFrom.length ? ` · ${p.mergedFrom.length} merged profile(s)` : ''}</div>
          <div className="flex flex-wrap gap-1.5">
            {p.identifiers.map((i) => (
              <Pill key={`${i.type}:${i.value}`}>
                {i.type}: <span className="font-mono">{i.value.length > 24 ? `${i.value.slice(0, 22)}…` : i.value}</span>
              </Pill>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Consent">
        <ul className="divide-y divide-line text-[13px]">
          {p.consent.map((c) => (
            <li key={`${c.purpose}:${c.channel}`} className="flex items-center gap-2 px-4 py-2">
              <span className="min-w-0 flex-1">
                {c.purpose}
                {c.channel && <span className="text-muted"> · {c.channel}</span>}
                <span className="text-[11px] text-muted"> · {c.basis.replace('_', ' ')} · via {c.source} · {timeAgo(Date.parse(c.updatedAt))}</span>
              </span>
              <Pill tone={consentTone[c.status as keyof typeof consentTone] ?? 'neutral'}>{c.status}</Pill>
            </li>
          ))}
          {!p.consent.length && <li className="px-4 py-3 text-muted">No choices recorded.</li>}
        </ul>
      </Card>

      <Card title="Events" action={<Pill>{events.length}</Pill>}>
        <ul className="max-h-[360px] divide-y divide-line overflow-y-auto font-mono text-[11px]">
          {events.map((e) => (
            <li key={e.eventId} className="flex gap-3 px-4 py-1.5">
              <span className="shrink-0 text-muted">{new Date(e.timestamp).toLocaleString()}</span>
              <span className="shrink-0">{e.name}</span>
              <span className="min-w-0 truncate text-muted">{JSON.stringify(e.properties)}</span>
            </li>
          ))}
          {!events.length && <li className="px-4 py-3 text-muted">No events.</li>}
        </ul>
      </Card>
    </div>
  );
}
