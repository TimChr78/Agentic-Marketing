// Agentic Marketing browser SDK (MIT). Speaks the Segment HTTP Tracking API, so the same calls
// work against any Segment-compatible collector, and puts consent first:
//
// - Nothing is stored and nothing is sent until the visitor has made a choice. Events are queued
//   in memory meanwhile and sent or discarded once they choose.
// - The choice itself is stored (strictly necessary) and reported to the server as Segment's
//   "Segment Consent Preference Updated" event, which lands in the consent ledger.
// - The anonymous id is kept in localStorage only while the tracking purpose is allowed.

import { type Decision, type PersonalizeOptions, personalize } from './personalize';

export { type BannerOptions, createConsentBanner, googleConsentDefaults } from './banner';
export { antiFlickerSnippet, type Decision, sanitize } from './personalize';

export type Consent = Record<string, boolean>;
type Props = Record<string, unknown>;

export interface AnalyticsOptions {
  writeKey: string;
  /** Collector origin, e.g. https://marketing.example.com */
  host: string;
  /** Purpose that must be allowed before events are sent (the source's required purpose). Default "analytics". */
  trackingPurpose?: string;
  /** Flush when this many events are queued. Default 20. */
  batchSize?: number;
  /** Flush at least this often (ms). Default 1000. */
  flushInterval?: number;
  /** Injection points, for tests and non-browser use. */
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  page?: () => { path: string; url: string; title: string; referrer: string };
  /** Landing-page query string and cookies to read ad click ids from; default: this page's. */
  landing?: () => { search: string; cookies: string };
  sendBeacon?: (url: string, body: string) => boolean;
}

interface QueuedEvent extends Props {
  type: string;
  messageId: string;
  timestamp: string;
  anonymousId?: string;
  userId?: string;
  context?: Props;
}

const LIB = { name: '@agentic-marketing/sdk-js', version: '0.1.0' };
const KEYS = { consent: 'am.consent', anonymousId: 'am.aid', userId: 'am.uid', clickIds: 'am.clk' };
const AD_PURPOSE = 'ad_measurement';
const CLICK_VALUE = /^[A-Za-z0-9._~-]{4,500}$/;

export type ClickIds = Partial<Record<'gclid' | 'gbraid' | 'wbraid' | 'fbc' | 'fbp' | 'msclkid', string>>;

/** Ad click ids on the landing page, plus Meta's _fbc/_fbp cookies when a Meta tag set them. */
export function captureClickIds(search: string, cookies: string, now = Date.now()): ClickIds {
  const q = new URLSearchParams(search);
  const out: ClickIds = {};
  for (const k of ['gclid', 'gbraid', 'wbraid', 'msclkid'] as const) {
    const v = q.get(k);
    if (v && CLICK_VALUE.test(v)) out[k] = v;
  }
  const fbclid = q.get('fbclid');
  if (fbclid && CLICK_VALUE.test(fbclid)) out.fbc = `fb.1.${now}.${fbclid}`;
  for (const part of cookies.split(';')) {
    const [k, v] = part.trim().split('=');
    if ((k === '_fbc' && !out.fbc) || k === '_fbp') if (v && CLICK_VALUE.test(v)) out[k.slice(1) as 'fbc' | 'fbp'] = v;
  }
  return out;
}
const CONSENT_EVENT = 'Segment Consent Preference Updated';
const MAX_QUEUE = 1000;

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;

function safeStorage(s: AnalyticsOptions['storage']) {
  // Storage can be missing or throw (private mode, blocked cookies); the SDK must keep working.
  return {
    get: (k: string) => {
      try {
        return s?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set: (k: string, v: string) => {
      try {
        s?.setItem(k, v);
      } catch {}
    },
    remove: (k: string) => {
      try {
        s?.removeItem(k);
      } catch {}
    },
  };
}

function browserPage() {
  if (typeof location === 'undefined') return undefined;
  return {
    path: location.pathname,
    url: location.href,
    title: typeof document === 'undefined' ? '' : document.title,
    referrer: typeof document === 'undefined' ? '' : document.referrer,
  };
}

export function createAnalytics(opts: AnalyticsOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const store = safeStorage(opts.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : opts.storage);
  const purpose = opts.trackingPurpose ?? 'analytics';
  const endpoint = `${opts.host.replace(/\/$/, '')}/v1/batch`;
  const auth = `Basic ${btoa(`${opts.writeKey}:`)}`;

  let consent: Consent | null = (() => {
    const raw = store.get(KEYS.consent);
    try {
      return raw ? (JSON.parse(raw) as Consent) : null;
    } catch {
      return null;
    }
  })();
  const allowed = () => consent?.[purpose] === true;
  let anonymousId = (allowed() && store.get(KEYS.anonymousId)) || uuid();
  let userId = (allowed() && store.get(KEYS.userId)) || undefined;
  // Click ids live in memory until ad_measurement is allowed, then (and only then) in storage.
  let clickIds: ClickIds = (() => {
    const stored = consent?.[AD_PURPOSE] === true ? store.get(KEYS.clickIds) : null;
    let saved: ClickIds = {};
    try {
      saved = stored ? (JSON.parse(stored) as ClickIds) : {};
    } catch {}
    const l = opts.landing?.() ?? {
      search: typeof location === 'undefined' ? '' : location.search,
      cookies: typeof document === 'undefined' ? '' : document.cookie,
    };
    return { ...saved, ...captureClickIds(l.search, l.cookies) };
  })();
  let pending: QueuedEvent[] = [];
  const outbox: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 0;

  const persistIds = () => {
    if (consent?.[AD_PURPOSE] === true && Object.keys(clickIds).length) store.set(KEYS.clickIds, JSON.stringify(clickIds));
    else store.remove(KEYS.clickIds);
    if (allowed()) {
      store.set(KEYS.anonymousId, anonymousId);
      if (userId) store.set(KEYS.userId, userId);
    } else {
      store.remove(KEYS.anonymousId);
      store.remove(KEYS.userId);
    }
  };

  function context(): Props {
    const page = (opts.page ?? browserPage)();
    return {
      library: LIB,
      ...(page ? { page } : {}),
      ...(typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent, locale: navigator.language } : {}),
      consent: { categoryPreferences: { ...(consent ?? {}) } },
      ...(consent?.[AD_PURPOSE] === true && Object.keys(clickIds).length ? { clickIds: { ...clickIds } } : {}),
    };
  }

  function enqueue(e: Omit<QueuedEvent, 'messageId' | 'timestamp'>) {
    const ev = { ...e, messageId: uuid(), timestamp: new Date().toISOString() } as QueuedEvent;
    if (consent === null) {
      // Undecided: hold in memory only.
      if (pending.length < MAX_QUEUE) pending.push(ev);
      return;
    }
    if (!allowed() && ev.event !== CONSENT_EVENT) return;
    outbox.push({ ...ev, anonymousId, ...(userId ? { userId } : {}), context: { ...context(), ...(ev.context ?? {}) } });
    if (outbox.length >= (opts.batchSize ?? 20)) void flush();
    else schedule();
  }

  function schedule() {
    if (!timer) timer = setTimeout(() => void flush(), (opts.flushInterval ?? 1000) + backoff);
  }

  // One send at a time, so a failed batch goes back in front of later ones and order is kept.
  let sending: Promise<void> = Promise.resolve();
  function flush(): Promise<void> {
    sending = sending.then(send);
    return sending;
  }

  async function send(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!outbox.length) return;
    const batch = outbox.splice(0, 100);
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({ batch, sentAt: new Date().toISOString() }),
        keepalive: true,
      });
      // Retry server trouble and rate limits; a 4xx means the events are wrong, retrying won't help.
      if (res.status >= 500 || res.status === 429) throw new Error(`collector answered ${res.status}`);
      backoff = 0;
    } catch {
      outbox.unshift(...batch.slice(0, MAX_QUEUE - outbox.length));
      backoff = Math.min(60_000, backoff ? backoff * 2 : 1000);
    }
    if (outbox.length) schedule();
  }

  /** Last chance on page hide: a beacon survives the page going away, fetch may not. */
  function flushOnHide() {
    if (!outbox.length) return;
    const beacon =
      opts.sendBeacon ?? (typeof navigator !== 'undefined' && navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : undefined);
    if (!beacon) return void flush();
    const batch = outbox.splice(0, 100);
    beacon(endpoint, JSON.stringify({ writeKey: opts.writeKey, batch, sentAt: new Date().toISOString() }));
  }
  if (typeof addEventListener === 'function')
    addEventListener('visibilitychange', () => typeof document !== 'undefined' && document.visibilityState === 'hidden' && flushOnHide());

  const api = {
    /** The visitor's current choice, or null if they have not chosen yet. */
    get consent(): Consent | null {
      return consent ? { ...consent } : null;
    },
    get anonymousId() {
      return anonymousId;
    },
    /** Collector origin and write key, for the consent banner. */
    get host() {
      return opts.host.replace(/\/$/, '');
    },
    get writeKey() {
      return opts.writeKey;
    },

    /** Record the visitor's choice (from your consent banner or CMP). Merges with earlier choices. */
    setConsent(choice: Consent) {
      const before = JSON.stringify(consent);
      consent = { ...(consent ?? {}), ...choice };
      store.set(KEYS.consent, JSON.stringify(consent));
      persistIds();
      if (JSON.stringify(consent) !== before) enqueue({ type: 'track', event: CONSENT_EVENT, properties: {} });
      const held = pending;
      pending = [];
      if (allowed())
        for (const e of held)
          outbox.push({ ...e, anonymousId, ...(userId ? { userId } : {}), context: { ...context(), ...(e.context ?? {}) } });
      void flush();
    },

    track(event: string, properties: Props = {}) {
      enqueue({ type: 'track', event, properties });
    },
    page(name?: string, properties: Props = {}) {
      enqueue({ type: 'page', ...(name ? { name } : {}), properties });
    },
    identify(id?: string | null, traits: Props = {}) {
      if (id) userId = id;
      persistIds();
      enqueue({ type: 'identify', traits, ...(id ? { userId: id } : {}) });
    },
    /** Ask the decision API what the given placements show. Works before consent too (page-only targeting). */
    async decide(placements: string[]): Promise<Decision[]> {
      const page = (opts.page ?? browserPage)();
      const res = await doFetch(`${opts.host.replace(/\/$/, '')}/v1/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({
          anonymousId,
          ...(userId ? { userId } : {}),
          placements,
          page: page ? { url: page.url, path: page.path, referrer: page.referrer } : undefined,
          context: {
            consent: { categoryPreferences: { ...(consent ?? {}) } },
            ...(typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {}),
          },
        }),
      });
      if (!res.ok) throw new Error(`decide answered ${res.status}`);
      return ((await res.json()) as { decisions: Decision[] }).decisions;
    },
    /** Decide, render the placements on this page, and report what was shown. */
    personalize(o: PersonalizeOptions = {}) {
      return personalize({ decide: (p) => api.decide(p), track: (e, props) => api.track(e, props) }, o);
    },
    /** Forget the visitor on this device (e.g. on logout): new anonymous id, no user id. */
    reset() {
      anonymousId = uuid();
      userId = undefined;
      clickIds = {};
      persistIds();
    },
    flush,
  };
  return api;
}
export type Analytics = ReturnType<typeof createAnalytics>;
