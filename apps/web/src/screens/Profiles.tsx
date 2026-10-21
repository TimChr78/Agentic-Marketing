import { useState } from 'react';
import { ArrowLeft, Download, Search, ShieldQuestion, Trash2 } from 'lucide-react';
import { useStore } from '../mock/store';
import { exec } from '../api/commands';
import type { Profile } from '../api/types';
import { Button, Card, PageHeader, Pill, cx, dkk, inputBase, timeAgo } from '../components/ui';

export function Profiles() {
  const { profiles, openProfileId, navigate } = useStore();
  const [q, setQ] = useState('');
  const open = profiles.find((p) => p.id === openProfileId);
  if (open) return <ProfileDetail profile={open} onBack={() => navigate('profiles', { profileId: null })} />;

  const list = profiles.filter((p) => [p.name, p.email, p.city, ...p.segments].some((v) => v?.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader eyebrow="Customer data" title="Profiles">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input id="profile-search" className={cx(inputBase, 'w-[260px] max-w-full pl-8')} placeholder="Name, e-mail, city or segment" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </PageHeader>
      <p className="-mt-2 mb-4 text-[13px] text-muted">
        Showing {list.length} of 28 290 profiles (sample). Deterministic identity resolution stitches anonymous ids, e-mail and user ids into one profile.
      </p>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Location</th>
                <th className="px-4 py-2.5 font-semibold">Segments</th>
                <th className="px-4 py-2.5 font-semibold">Marketing e-mail</th>
                <th className="px-4 py-2.5 text-right font-semibold">Orders</th>
                <th className="px-4 py-2.5 text-right font-semibold">LTV</th>
                <th className="px-4 py-2.5 text-right font-semibold">Last seen</th>
              </tr>
            </thead>
            <tbody className="num divide-y divide-line">
              {list.map((p) => {
                const c = p.consent.find((x) => x.purpose === 'marketing_email');
                return (
                  <tr key={p.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate('profiles', { profileId: p.id })}>
                    <td className="px-4 py-2.5">
                      <div className="font-semibold">{p.name}</div>
                      <div className="text-[12px] text-muted">{p.email}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      {p.city}, {p.country}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {p.segments.map((s) => (
                          <Pill key={s}>{s.replace('seg_', '')}</Pill>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <ConsentPill c={c} />
                    </td>
                    <td className="px-4 py-2.5 text-right">{p.orders}</td>
                    <td className="px-4 py-2.5 text-right">{dkk(p.ltv)}</td>
                    <td className="px-4 py-2.5 text-right text-muted">{timeAgo(p.lastSeen)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ConsentPill({ c }: { c?: Profile['consent'][number] }) {
  if (!c) return <Pill>—</Pill>;
  const allowed = c.basis === 'consent' ? c.status === 'granted' : c.status !== 'objected' && c.status !== 'denied';
  return (
    <Pill tone={allowed ? 'good' : 'bad'}>
      {allowed ? 'allowed' : c.status} · {c.basis === 'legitimate_interest' ? 'LI' : c.basis}
    </Pill>
  );
}

function ProfileDetail({ profile: p, onBack }: { profile: Profile; onBack: () => void }) {
  const { events, journeys, toast } = useStore();
  const [explain, setExplain] = useState<Record<string, string> | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const mine = events.filter((e) => e.profileId === p.id || p.anonymousIds.includes(e.anonymousId)).slice(0, 12);

  async function canEmail() {
    setExplain(await exec('consent.explain', { profileId: p.id, purpose: 'marketing_email' }));
  }
  function erase() {
    useStore.setState((s) => ({ profiles: s.profiles.filter((x) => x.id !== p.id) }));
    toast(`Erased ${p.name}: rows deleted, per-profile key destroyed, e-mail hash kept on suppression list`, 'good');
    onBack();
  }

  return (
    <div className="mx-auto max-w-[1200px]">
      <button className="mb-3 flex items-center gap-1 text-[13px] text-muted hover:text-fg" onClick={onBack}>
        <ArrowLeft size={14} /> Profiles
      </button>
      <PageHeader eyebrow={`${p.id} · ${p.city}, ${p.country}`} title={p.name}>
        <Button onClick={canEmail}>
          <ShieldQuestion size={14} /> Can we e-mail?
        </Button>
        <Button onClick={() => setExported(JSON.stringify({ profile: p, events: mine }, null, 2))}>
          <Download size={14} /> Access request
        </Button>
        {confirmErase ? (
          <>
            <Button variant="danger" onClick={erase}>
              Confirm erasure
            </Button>
            <Button variant="ghost" onClick={() => setConfirmErase(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="danger" onClick={() => setConfirmErase(true)}>
            <Trash2 size={14} /> Erase
          </Button>
        )}
      </PageHeader>

      {explain && (
        <div className={cx('mb-4 rounded-md border px-4 py-3 text-[13px]', explain.allowed ? 'border-good/40 bg-good-soft text-good' : 'border-bad/40 bg-bad-soft text-bad')}>
          <b>{explain.allowed ? 'Yes.' : 'No.'}</b> {explain.reason} Basis: {String(explain.basis).replace('_', ' ')}. Source: {explain.source} ({explain.recordedAt}).
        </div>
      )}
      {exported && (
        <Card title="Data subject access export (JSON)" className="mb-4" action={<Button variant="ghost" onClick={() => setExported(null)}>Close</Button>}>
          <pre className="max-h-[260px] overflow-auto p-4 font-mono text-[11px] text-muted">{exported}</pre>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Traits">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-[13px]">
            <dt className="text-muted">E-mail</dt>
            <dd className="min-w-0 truncate">
              {p.email} <Pill tone="warn">PII · encrypted</Pill>
            </dd>
            {Object.entries(p.traits).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-[12px] text-muted">{k}</dt>
                <dd className="min-w-0 truncate">{String(v)}</dd>
              </div>
            ))}
            <dt className="text-muted">Orders</dt>
            <dd className="num">{p.orders}</dd>
            <dt className="text-muted">LTV</dt>
            <dd className="num">{dkk(p.ltv)}</dd>
          </dl>
          <div className="border-t border-line px-4 py-3">
            <div className="eyebrow mb-1.5">Identities</div>
            <ul className="space-y-1 font-mono text-[12px]">
              {p.email && <li>email: {p.email}</li>}
              {p.anonymousIds.map((a) => (
                <li key={a}>anonymous_id: {a}</li>
              ))}
            </ul>
          </div>
        </Card>

        <Card title="Consent & lawful basis" className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wider text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-semibold">Purpose</th>
                  <th className="px-4 py-2 font-semibold">Basis</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Source (proof)</th>
                  <th className="px-4 py-2 text-right font-semibold">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {p.consent.map((c) => (
                  <tr key={c.purpose}>
                    <td className="px-4 py-2 font-mono text-[12px]">{c.purpose}</td>
                    <td className="px-4 py-2">{c.basis.replace('_', ' ')}</td>
                    <td className="px-4 py-2">
                      <Pill tone={c.status === 'granted' ? 'good' : c.status === 'objected' || c.status === 'denied' ? 'bad' : 'neutral'}>{c.status.replace('_', ' ')}</Pill>
                    </td>
                    <td className="px-4 py-2 text-muted">{c.source}</td>
                    <td className="num px-4 py-2 text-right text-muted">{new Date(c.at).toLocaleDateString('en-GB')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-4 border-t border-line px-4 py-3 sm:grid-cols-2">
            <div>
              <div className="eyebrow mb-1.5">Segments</div>
              <div className="flex flex-wrap gap-1">
                {p.segments.map((s) => (
                  <Pill key={s}>{s}</Pill>
                ))}
              </div>
            </div>
            <div>
              <div className="eyebrow mb-1.5">Journeys</div>
              <div className="flex flex-wrap gap-1">
                {p.journeys.map((id) => (
                  <Pill key={id} tone="accent">
                    {journeys.find((j) => j.id === id)?.name ?? id}
                  </Pill>
                ))}
                {!p.journeys.length && <span className="text-[12px] text-muted">None active</span>}
              </div>
            </div>
          </div>
          <div className="border-t border-line">
            <div className="eyebrow px-4 pt-3">Recent events</div>
            <ul className="divide-y divide-line font-mono text-[11px]">
              {mine.map((e) => (
                <li key={e.id} className="flex gap-3 px-4 py-1.5">
                  <span className="num text-muted">{new Date(e.at).toLocaleTimeString('en-GB')}</span>
                  <span>{e.name}</span>
                  <span className="min-w-0 truncate text-muted">{JSON.stringify(e.properties)}</span>
                </li>
              ))}
              {!mine.length && <li className="px-4 py-3 font-sans text-[12px] text-muted">No events in this session yet. Ambient traffic will show up here.</li>}
            </ul>
          </div>
        </Card>
      </div>
    </div>
  );
}
