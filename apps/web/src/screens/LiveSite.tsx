import { useState } from 'react';
import { Backpack, Footprints, Lock, RotateCcw, Shirt, ShoppingCart, Tent, type LucideIcon } from 'lucide-react';
import { useStore } from '../mock/store';
import { sdk, useLive, type Decision } from '../mock/live';
import { Button, Card, PageHeader, Pill, cx } from '../components/ui';

type Category = 'shoes' | 'jackets' | 'tents' | 'backpacks';
const products: { sku: string; name: string; price: number; category: Category }[] = [
  { sku: 'SH-01', name: 'Trailrunner GTX', price: 1199, category: 'shoes' },
  { sku: 'SH-02', name: 'Fjeld Approach', price: 999, category: 'shoes' },
  { sku: 'SH-03', name: 'Skyline Racer', price: 1349, category: 'shoes' },
  { sku: 'JA-01', name: 'Storm Shell', price: 2199, category: 'jackets' },
  { sku: 'JA-02', name: 'Fleece Mid', price: 749, category: 'jackets' },
  { sku: 'TE-01', name: 'Ridge 2P Tent', price: 3499, category: 'tents' },
  { sku: 'BP-01', name: 'Daypack 22 L', price: 649, category: 'backpacks' },
  { sku: 'BP-02', name: 'Trek 45 L', price: 1599, category: 'backpacks' },
];
const icons: Record<Category, LucideIcon> = { shoes: Footprints, jackets: Shirt, tents: Tent, backpacks: Backpack };

const heroCopy: Record<Decision['variant'], { title: string; text: string; cta: string }> = {
  default: { title: 'The autumn range is in', text: 'Waterproof layers, warmer bags and grippier soles for wet Nordic trails.', cta: 'Shop the range' },
  shoes: { title: 'Trail shoes, picked for you', text: 'Based on what you looked at today. Use TRAIL10 for 10% off running shoes until Sunday.', cta: 'See trail shoes' },
  jackets: { title: 'Shells for sideways rain', text: 'You have been comparing jackets. These three handle a Danish November.', cta: 'Compare jackets' },
  tents: { title: 'Ready for a night out?', text: 'Our lightest 2-person tents, with free pitching lessons in Copenhagen.', cta: 'See tents' },
};

export function LiveSite() {
  const live = useLive();
  const events = useStore((s) => s.events);
  const profile = useStore((s) => s.profiles.find((p) => p.id === live.profileId));
  const [onlyMine, setOnlyMine] = useState(true);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const hero = heroCopy[live.decision.variant];
  const shown = events.filter((e) => !onlyMine || e.anonymousId === live.anonymousId).slice(0, 30);

  return (
    <div className="mx-auto max-w-[1300px]">
      <PageHeader eyebrow="Ingest → session state → decide, in your browser" title="Live site demo">
        <Button variant="ghost" onClick={() => sdk.reset()}>
          <RotateCcw size={14} /> New visitor
        </Button>
      </PageHeader>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* The customer's website */}
        <div className="overflow-hidden rounded-lg border border-line shadow-sm">
          <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span className="flex gap-1">
              <i className="h-2.5 w-2.5 rounded-full bg-line" />
              <i className="h-2.5 w-2.5 rounded-full bg-line" />
              <i className="h-2.5 w-2.5 rounded-full bg-line" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded bg-surface px-2 py-1 font-mono text-[11px] text-muted">
              <Lock size={11} /> <span className="truncate">fjeldvej.example/{filter === 'all' ? '' : filter}</span>
            </span>
            <span className="relative flex items-center gap-1 text-[12px] text-muted">
              <ShoppingCart size={15} />
              <span className="num">{live.cart.length}</span>
            </span>
          </div>

          <div className="relative bg-shop-bg text-shop-fg" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="text-[19px] font-bold">Fjeldvej Outdoor</div>
              <div className="flex flex-wrap gap-3 text-[13px]" style={{ fontFamily: 'var(--font-sans)' }}>
                {(['all', 'shoes', 'jackets', 'tents', 'backpacks'] as const).map((c) => (
                  <button
                    key={c}
                    className={cx('capitalize', filter === c && 'font-semibold underline underline-offset-4')}
                    onClick={() => {
                      setFilter(c);
                      sdk.track('page_viewed', { path: c === 'all' ? '/' : `/${c}` }, 'page');
                    }}
                  >
                    {c === 'all' ? 'Home' : c}
                  </button>
                ))}
              </div>
            </div>

            <div key={live.decision.variant} className="flash-in mx-5 rounded-md bg-shop-accent px-6 py-7 text-shop-bg">
              <div className="text-[11px] uppercase tracking-widest opacity-80" style={{ fontFamily: 'var(--font-sans)' }}>
                {live.decision.variant === 'default' ? 'New season' : 'Personalised in this session'}
              </div>
              <div className="mt-1 text-[26px] leading-tight font-bold">{hero.title}</div>
              <p className="mt-2 max-w-[52ch] text-[14px] opacity-90" style={{ fontFamily: 'var(--font-sans)' }}>
                {hero.text}
              </p>
              <button
                className="mt-4 rounded bg-shop-bg px-4 py-2 text-[13px] font-semibold text-shop-fg"
                style={{ fontFamily: 'var(--font-sans)' }}
                onClick={() => setFilter(live.decision.variant === 'default' ? 'all' : (live.decision.variant as Category))}
              >
                {hero.cta}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4" style={{ fontFamily: 'var(--font-sans)' }}>
              {products
                .filter((p) => filter === 'all' || p.category === filter)
                .map((p) => {
                  const Icon = icons[p.category];
                  return (
                    <div key={p.sku} className="min-w-0 rounded-md border border-shop-fg/10 bg-shop-bg">
                      <button
                        className="flex aspect-[4/3] w-full max-w-full items-center justify-center rounded-t-md bg-shop-fg/5 hover:bg-shop-fg/10"
                        onClick={() => sdk.track('product_viewed', { sku: p.sku, name: p.name, category: p.category, price: p.price })}
                        aria-label={`View ${p.name}`}
                      >
                        <Icon size={34} strokeWidth={1.4} />
                      </button>
                      <div className="p-2.5">
                        <div className="truncate text-[13px] font-semibold">{p.name}</div>
                        <div className="num text-[12px] opacity-70">{p.price.toLocaleString('da-DK')} kr</div>
                        <div className="mt-2 flex gap-1.5">
                          <button
                            className="rounded border border-shop-fg/20 px-2 py-1 text-[11px] hover:bg-shop-fg/5"
                            onClick={() => sdk.track('product_viewed', { sku: p.sku, name: p.name, category: p.category, price: p.price })}
                          >
                            View
                          </button>
                          <button
                            className="rounded bg-shop-accent px-2 py-1 text-[11px] font-semibold text-shop-bg"
                            onClick={() => sdk.track('product_added', { sku: p.sku, name: p.name, price: p.price })}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>

            <div className="grid gap-3 border-t border-shop-fg/10 px-5 py-4 sm:grid-cols-2" style={{ fontFamily: 'var(--font-sans)' }}>
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (email.includes('@')) sdk.identify(email, firstName);
                }}
              >
                <div className="text-[13px] font-semibold">Get trail news (and 10% off)</div>
                <div className="flex gap-2">
                  <input id="shop-first" className="w-1/3 min-w-0 rounded border border-shop-fg/20 bg-transparent px-2 py-1 text-[12px]" placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  <input id="shop-email" type="email" className="min-w-0 flex-1 rounded border border-shop-fg/20 bg-transparent px-2 py-1 text-[12px]" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <button className="rounded bg-shop-accent px-3 py-1 text-[12px] font-semibold text-shop-bg">Sign up</button>
                </div>
                <span className="text-[11px] opacity-60">Try anna.jensen@example.com to log in as an existing customer.</span>
              </form>
              <div className="flex flex-col gap-2">
                <div className="text-[13px] font-semibold">Cart ({live.cart.length})</div>
                <div className="truncate text-[12px] opacity-75">{live.cart.map((c) => c.name).join(', ') || 'Empty'}</div>
                <div className="flex gap-2">
                  <button
                    disabled={!live.cart.length}
                    className="rounded bg-shop-accent px-3 py-1 text-[12px] font-semibold text-shop-bg disabled:opacity-40"
                    onClick={() => sdk.track('order_completed', { value: live.cart.reduce((a, c) => a + c.price, 0), currency: 'DKK' })}
                  >
                    Check out
                  </button>
                  <button disabled={!live.cart.length} className="rounded border border-shop-fg/20 px-3 py-1 text-[12px] disabled:opacity-40" onClick={() => sdk.abandonCart()}>
                    Leave the site
                  </button>
                </div>
              </div>
            </div>

            {live.consent === 'unset' && (
              <div className="absolute inset-x-3 bottom-3 rounded-md border border-shop-fg/15 bg-shop-bg p-4 shadow-xl" style={{ fontFamily: 'var(--font-sans)' }}>
                <div className="text-[14px] font-semibold">Cookies on Fjeldvej</div>
                <p className="mt-1 text-[12px] opacity-80">
                  We use analytics and personalisation to show gear that fits what you are looking for. Strictly necessary cookies are always on.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="rounded bg-shop-accent px-3 py-1.5 text-[12px] font-semibold text-shop-bg" onClick={() => sdk.setConsent('all')}>
                    Accept all
                  </button>
                  <button className="rounded border border-shop-fg/25 px-3 py-1.5 text-[12px]" onClick={() => sdk.setConsent('necessary')}>
                    Strictly necessary only
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* What the platform sees */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Decision: home_hero" action={<Pill tone="accent">{live.decision.latencyMs} ms</Pill>}>
            <div className="space-y-1 px-4 py-3 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="text-muted">Variant</span>
                <Pill tone={live.decision.variant === 'default' ? 'neutral' : 'good'}>{live.decision.variant}</Pill>
                <span className="text-muted">from</span>
                <code className="font-mono text-[12px]">{live.decision.experience}</code>
              </div>
              <div className="text-muted">{live.decision.reason}</div>
              <div className="num flex flex-wrap gap-2 pt-1">
                {Object.entries(live.views).map(([k, v]) => (
                  <Pill key={k}>
                    {k}: {v}
                  </Pill>
                ))}
                {!Object.keys(live.views).length && <span className="text-[12px] text-muted">Session counters appear here.</span>}
              </div>
            </div>
          </Card>

          <Card title="Visitor" action={<Pill tone={live.consent === 'all' ? 'good' : live.consent === 'necessary' ? 'warn' : 'neutral'}>consent: {live.consent}</Pill>}>
            <div className="grid gap-x-4 gap-y-1 px-4 py-3 text-[13px] sm:grid-cols-2">
              <div className="min-w-0">
                <span className="text-muted">Anonymous id </span>
                <code className="font-mono text-[12px]">{live.anonymousId}</code>
              </div>
              <div className="min-w-0 truncate">
                <span className="text-muted">Profile </span>
                {profile ? (
                  <button className="font-semibold text-accent" onClick={() => useStore.getState().navigate('profiles', { profileId: profile.id })}>
                    {profile.name}
                  </button>
                ) : (
                  'not identified'
                )}
              </div>
              <div className="flex flex-wrap gap-1 pt-1 sm:col-span-2">
                {(profile?.segments ?? live.segments).map((s) => (
                  <Pill key={s} tone={live.segments.includes(s) ? 'good' : 'neutral'}>
                    {s}
                  </Pill>
                ))}
              </div>
            </div>
          </Card>

          <Card title="Pipeline">
            <ul className="max-h-[200px] divide-y divide-line overflow-y-auto text-[12px]">
              {live.notes.map((n) => (
                <li key={n.id} className={cx('flash-in flex gap-2 px-4 py-2', n.tone === 'good' && 'text-good', n.tone === 'bad' && 'text-bad')}>
                  <span className="w-[62px] shrink-0 font-semibold uppercase tracking-wide text-muted">{n.kind}</span>
                  <span className="min-w-0">{n.text}</span>
                </li>
              ))}
              {!live.notes.length && <li className="px-4 py-3 text-muted">Choose a cookie option in the shop to start.</li>}
            </ul>
          </Card>

          <Card
            title="Event stream"
            action={
              <label className="flex items-center gap-1.5 text-[12px] text-muted">
                <input id="only-mine" type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> This visitor only
              </label>
            }
          >
            <ul className="max-h-[280px] divide-y divide-line overflow-y-auto font-mono text-[11px]">
              {shown.map((e) => (
                <li key={e.id} className="flash-in flex items-center gap-2 px-4 py-1.5">
                  <span className="num w-[64px] shrink-0 text-muted">{new Date(e.at).toLocaleTimeString('en-GB')}</span>
                  <span className={cx('w-[54px] shrink-0', e.type === 'identify' ? 'text-agent' : 'text-muted')}>{e.type}</span>
                  <span className={cx('min-w-0 flex-1 truncate', e.status !== 'accepted' && 'text-muted line-through')}>
                    {e.name} {Object.keys(e.properties).length ? JSON.stringify(e.properties) : ''}
                  </span>
                  {e.status === 'accepted' ? <span className="num text-muted">{e.latencyMs}ms</span> : <span className="text-warn">dropped: no consent</span>}
                </li>
              ))}
              {!shown.length && <li className="px-4 py-3 text-muted">No events yet.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
