import { create } from 'zustand';
import type { Profile, TrackedEvent } from '../api/types';
import { useStore } from './store';

// Mock of the ingest → session state → decide hot path (channels-and-personalization.md §3)
// plus the journey trigger matcher, compressed in time so it can be shown live.

export type ConsentChoice = 'unset' | 'all' | 'necessary';
export interface Decision {
  placement: string;
  experience: string;
  variant: 'default' | 'shoes' | 'jackets' | 'tents';
  reason: string;
  latencyMs: number;
}
export interface SystemNote {
  id: string;
  at: number;
  kind: 'segment' | 'journey' | 'message' | 'identity' | 'consent';
  text: string;
  tone: 'good' | 'agent' | 'bad' | 'neutral';
}

interface LiveState {
  consent: ConsentChoice;
  anonymousId: string;
  profileId: string | null;
  views: Record<string, number>;
  cart: { sku: string; name: string; price: number }[];
  decision: Decision;
  notes: SystemNote[];
  segments: string[];
}

const initialDecision: Decision = {
  placement: 'home_hero',
  experience: 'exp_hero',
  variant: 'default',
  reason: 'No session signals yet: default variant',
  latencyMs: 9,
};

export const useLive = create<LiveState>(() => ({
  consent: 'unset',
  anonymousId: `anon_${Math.random().toString(36).slice(2, 10)}`,
  profileId: null,
  views: {},
  cart: [],
  decision: initialDecision,
  notes: [],
  segments: [],
}));

let seq = 0;
const nid = () => `ev_${Date.now().toString(36)}${(++seq).toString(36)}`;
const STRICTLY_NECESSARY = new Set(['checkout_started', 'order_completed', 'consent_updated']);
let cartTimer: ReturnType<typeof setTimeout> | undefined;

function note(kind: SystemNote['kind'], text: string, tone: SystemNote['tone'] = 'neutral') {
  useLive.setState((s) => ({ notes: [{ id: nid(), at: Date.now(), kind, text, tone }, ...s.notes].slice(0, 40) }));
}

function pushEvent(ev: TrackedEvent) {
  useStore.setState((s) => ({ events: [ev, ...s.events].slice(0, 300) }));
}

function decide(): Decision {
  const { consent, views } = useLive.getState();
  const start = performance.now();
  let d: Decision;
  if (consent !== 'all') {
    d = { ...initialDecision, reason: 'No personalization consent: contextual targeting only (page, country)', latencyMs: 0 };
  } else {
    const [top, count] = Object.entries(views).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    d =
      count >= 3
        ? { ...initialDecision, variant: top as Decision['variant'], reason: `Session: viewed ${count} ${top} products (rule ≥ 3)` }
        : { ...initialDecision, reason: count ? `Session: ${count}/3 views of ${top}, keeps default` : initialDecision.reason };
  }
  d.latencyMs = Math.max(4, Math.round(performance.now() - start + 6 + Math.random() * 9));
  return d;
}

export const sdk = {
  setConsent(choice: ConsentChoice) {
    useLive.setState({ consent: choice });
    sdk.track('consent_updated', { analytics: choice === 'all', personalization: choice === 'all' });
    note('consent', choice === 'all' ? 'Consent granted: analytics + personalization' : 'Strictly necessary only: no profiling, no personalization', choice === 'all' ? 'good' : 'neutral');
    useLive.setState({ decision: decide() });
  },

  track(name: string, properties: Record<string, unknown> = {}, type: TrackedEvent['type'] = 'track') {
    const live = useLive.getState();
    const allowed = live.consent === 'all' || STRICTLY_NECESSARY.has(name);
    const ev: TrackedEvent = {
      id: nid(),
      at: Date.now(),
      type,
      name,
      anonymousId: live.anonymousId,
      profileId: live.profileId ?? undefined,
      properties,
      status: allowed ? 'accepted' : 'dropped_no_consent',
      latencyMs: Math.round(4 + Math.random() * 11),
    };
    pushEvent(ev);
    if (!allowed) return;

    if (name === 'product_viewed') {
      const cat = String(properties.category);
      const views = { ...live.views, [cat]: (live.views[cat] ?? 0) + 1 };
      useLive.setState({ views });
      if (cat === 'shoes' && views.shoes === 3 && !live.segments.includes('seg_trail_runners')) {
        useLive.setState((s) => ({ segments: [...s.segments, 'seg_trail_runners'] }));
        note('segment', 'Entered real-time segment “Trail runners” (3 shoe views in 7 days)', 'good');
      }
    }
    if (name === 'product_added') {
      useLive.setState((s) => ({ cart: [...s.cart, properties as LiveState['cart'][number]] }));
      clearTimeout(cartTimer);
      note('journey', 'Cart timer started: “cart_abandoned” fires after 30 min without checkout (demo: 12 s)');
      cartTimer = setTimeout(() => sdk.abandonCart(), 12_000);
    }
    if (name === 'order_completed') {
      clearTimeout(cartTimer);
      useLive.setState({ cart: [] });
      note('journey', 'Order completed: cart timer cancelled, goal reached', 'good');
    }
    useLive.setState({ decision: decide() });
  },

  identify(email: string, firstName: string) {
    const live = useLive.getState();
    const store = useStore.getState();
    let profile: Profile | undefined = store.profiles.find((p) => p.email?.toLowerCase() === email.toLowerCase());
    if (profile) {
      useStore.setState((s) => ({
        profiles: s.profiles.map((p) => (p.id === profile!.id ? { ...p, anonymousIds: [...p.anonymousIds, live.anonymousId], lastSeen: Date.now() } : p)),
      }));
      note('identity', `Identity resolved: ${live.anonymousId} merged into existing profile ${profile.name}`, 'good');
    } else {
      profile = {
        id: `prf_${Math.random().toString(36).slice(2, 8)}`,
        name: firstName || email.split('@')[0],
        email,
        anonymousIds: [live.anonymousId],
        city: 'Copenhagen',
        country: 'DK',
        traits: { first_name: firstName || email.split('@')[0], locale: 'da-DK', newsletter: true, preferred_category: 'shoes' },
        segments: ['seg_prospects', ...live.segments],
        consent: [
          { purpose: 'marketing_email', channel: 'email', basis: 'consent', status: 'granted', source: 'Newsletter form (double opt-in pending)', at: Date.now() },
          { purpose: 'web_personalization', channel: 'web', basis: 'consent', status: live.consent === 'all' ? 'granted' : 'denied', source: 'Cookie banner', at: Date.now() },
        ],
        lastSeen: Date.now(),
        ltv: 0,
        orders: 0,
        journeys: ['jrn_welcome'],
      };
      useStore.setState((s) => ({ profiles: [profile!, ...s.profiles] }));
      note('identity', `New profile ${profile.name} created; anonymous history (${Object.values(live.views).reduce((a, b) => a + b, 0)} events) stitched to it`, 'good');
      note('journey', 'Entered journey “Welcome series” (trigger: signed_up)', 'good');
    }
    useLive.setState({ profileId: profile.id });
    sdk.track('signed_up', { email_domain: email.split('@')[1] }, 'identify');
  },

  abandonCart() {
    const live = useLive.getState();
    if (!live.cart.length) return;
    sdk.track('cart_abandoned', { items: live.cart.length, value: live.cart.reduce((a, c) => a + c.price, 0) });
    note('journey', 'Entered journey “Abandoned cart” v7 (trigger: cart_abandoned)', 'good');
    setTimeout(() => {
      const st = useLive.getState();
      const p = useStore.getState().profiles.find((x) => x.id === st.profileId);
      if (!p) note('message', 'Send gateway: no e-mail identity yet, step waits for identify (sign up to see the e-mail)', 'neutral');
      else {
        const c = p.consent.find((x) => x.purpose === 'marketing_email');
        if (c?.status === 'objected' || (c?.basis === 'consent' && c.status !== 'granted'))
          note('message', `Send gateway suppressed “Reminder: 10% off” for ${p.name}: ${c?.status}`, 'bad');
        else note('message', `Send gateway: “Reminder: 10% off” (variant A) queued for ${p.email} via SMTP relay`, 'good');
      }
    }, 3500);
  },

  reset() {
    clearTimeout(cartTimer);
    useLive.setState({
      consent: 'unset',
      anonymousId: `anon_${Math.random().toString(36).slice(2, 10)}`,
      profileId: null,
      views: {},
      cart: [],
      decision: initialDecision,
      notes: [],
      segments: [],
    });
  },
};

// Background traffic from other visitors so the stream looks like a real site.
const pages = ['/', '/shoes', '/jackets', '/tents', '/backpacks', '/product/trailrunner-gtx', '/cart'];
const names = ['page_viewed', 'product_viewed', 'product_viewed', 'search', 'product_added', 'email_clicked', 'order_completed'];
function ambientEvent(at: number) {
  const profiles = useStore.getState().profiles;
  const p = profiles[Math.floor(Math.random() * profiles.length)];
  const name = names[Math.floor(Math.random() * names.length)];
  pushEvent({
      id: nid(),
      at,
      type: name === 'page_viewed' ? 'page' : 'track',
      name,
      anonymousId: p.anonymousIds[0],
      profileId: Math.random() > 0.4 ? p.id : undefined,
      properties: name === 'page_viewed' ? { path: pages[Math.floor(Math.random() * pages.length)] } : { category: p.traits.preferred_category },
      status: Math.random() > 0.12 ? 'accepted' : 'dropped_no_consent',
      latencyMs: Math.round(3 + Math.random() * 14),
  });
}

export function startAmbientTraffic() {
  // Backfill the last minute so counters are not empty on first load.
  if (!useStore.getState().events.length) for (let i = 40; i > 0; i--) ambientEvent(Date.now() - i * 1500);
  const id = setInterval(() => ambientEvent(Date.now()), 1600);
  return () => clearInterval(id);
}
