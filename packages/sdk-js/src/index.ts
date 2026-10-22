// Agentic Marketing browser SDK (MIT). Speaks the Segment HTTP Tracking API, so the same calls
// work against any Segment-compatible collector, and puts consent first:
//
// - Nothing is stored and nothing is sent until the visitor has made a choice. Events are queued
//   in memory meanwhile and sent or discarded once they choose.
// - The choice itself is stored (strictly necessary) and reported to the server as Segment's
//   "Segment Consent Preference Updated" event, which lands in the consent ledger.
// - The anonymous id is kept in localStorage only while the tracking purpose is allowed.

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
const KEYS = { consent: 'am.consent', anonymousId: 'am.aid', userId: 'am.uid' };
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
  let pending: QueuedEvent[] = [];
  const outbox: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 0;

  const persistIds = () => {
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

  return {
    /** The visitor's current choice, or null if they have not chosen yet. */
    get consent(): Consent | null {
      return consent ? { ...consent } : null;
    },
    get anonymousId() {
      return anonymousId;
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
    /** Forget the visitor on this device (e.g. on logout): new anonymous id, no user id. */
    reset() {
      anonymousId = uuid();
      userId = undefined;
      persistIds();
    },
    flush,
  };
}
export type Analytics = ReturnType<typeof createAnalytics>;
