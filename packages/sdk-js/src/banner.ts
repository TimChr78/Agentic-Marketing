// Consent banner (Phase 8): a small, accessible banner that records the visitor's choice per
// purpose with `analytics.setConsent` (so it lands in the consent ledger as proof) and mirrors it
// to Google Consent Mode v2 for sites that run Google tags.
//
// CSP-safe: no inline script, no HTML strings; elements are built with the DOM and styled through
// CSSOM, which `style-src` without 'unsafe-inline' allows. Texts come from the workspace's
// `purposes` artifact (GET <host>/v1/consent/purposes) unless given.

import type { Consent } from './index';

export interface BannerPurpose {
  key: string;
  name: string;
  description: string;
  /** Purposes that do not need consent are on by default, and the visitor can refuse them. */
  basis: string;
}

export interface BannerTexts {
  title: string;
  body: string;
  acceptAll: string;
  rejectAll: string;
  settings: string;
  save: string;
  alwaysOn: string;
  privacy: string;
}

export interface BannerOptions {
  /** Default: the workspace's purposes for the web. */
  purposes?: BannerPurpose[];
  texts?: Partial<BannerTexts>;
  privacyUrl?: string;
  /** Mirror choices to Google Consent Mode v2 (gtag or dataLayer). Default: true. */
  googleConsentMode?: boolean;
  /** Show even when the visitor already chose (e.g. a "cookie settings" page). */
  open?: boolean;
  /** Accent color of the primary buttons. */
  accent?: string;
  document?: Document;
  fetch?: typeof fetch;
}

interface AnalyticsLike {
  readonly consent: Consent | null;
  readonly host: string;
  readonly writeKey: string;
  setConsent(choice: Consent): void;
  /**
   * Tells the SDK which purposes need consent and which hold until someone objects. The banner
   * already fetches them, so the tracking gate uses the same basis as the gateway (#1224).
   */
  setPurposes?(purposes: { key: string; basis: string }[]): void;
  /**
   * Announces that a purpose lookup is starting, so the SDK holds events for an unresolved purpose
   * instead of dropping them before the answer arrives.
   */
  beginPurposes?(): void;
  /** The lookup failed; the SDK drops what it held rather than sending on an unknown basis. */
  failPurposes?(): void;
}

const DEFAULT_TEXTS: BannerTexts = {
  title: 'Your privacy',
  body: 'We would like your permission to use data for the purposes below. You can change your choice at any time.',
  acceptAll: 'Accept all',
  rejectAll: 'Reject all',
  settings: 'Choose',
  save: 'Save choices',
  alwaysOn: 'Always on',
  privacy: 'Privacy policy',
};

type Win = Window & { gtag?: (...args: unknown[]) => void; dataLayer?: unknown[] };

function gtagOf(win: Win) {
  if (typeof win.gtag === 'function') return win.gtag;
  return function gtag() {
    // gtag pushes the arguments object itself; Google's tag reads it that way.
    win.dataLayer = win.dataLayer ?? [];
    // biome-ignore lint/complexity/noArguments: the dataLayer protocol needs the arguments object
    win.dataLayer.push(arguments);
  };
}

const mode = (c: Consent) => {
  const g = (b: boolean | undefined) => (b ? 'granted' : 'denied');
  return {
    analytics_storage: g(c.analytics),
    ad_storage: g(c.ad_measurement || c.ad_targeting),
    ad_user_data: g(c.ad_measurement),
    ad_personalization: g(c.ad_targeting),
  };
};

/**
 * Google Consent Mode v2 defaults: everything denied until the visitor chooses (or their earlier
 * choice). Call it before Google's tag loads; createConsentBanner calls it too.
 */
export function googleConsentDefaults(win: Win, current: Consent | null = null) {
  const gtag = gtagOf(win);
  gtag('consent', 'default', { ...mode(current ?? {}), wait_for_update: 500 });
}

export function createConsentBanner(analytics: AnalyticsLike, opts: BannerOptions = {}) {
  const doc = opts.document ?? document;
  const win = doc.defaultView as Win;
  const texts = { ...DEFAULT_TEXTS, ...(opts.texts ?? {}) };
  const accent = opts.accent ?? '#2f5bea';
  const useGcm = opts.googleConsentMode !== false;
  if (useGcm && win) googleConsentDefaults(win, analytics.consent);

  let root: HTMLElement | null = null;
  let purposes: BannerPurpose[] = opts.purposes ?? [];

  const loadPurposes = async () => {
    // A returning visitor can call `page()` before this answer arrives. The SDK holds those events
    // until the bases are known instead of dropping a purpose the answer may allow (#1224 review).
    analytics.beginPurposes?.();
    try {
      if (!opts.purposes) {
        const doFetch = opts.fetch ?? win.fetch.bind(win);
        const res = await doFetch(`${analytics.host}/v1/consent/purposes?writeKey=${encodeURIComponent(analytics.writeKey)}`);
        if (!res.ok) throw new Error(`purposes answered ${res.status}`);
        purposes = ((await res.json()) as { purposes: BannerPurpose[] }).purposes;
      }
    } catch (err) {
      // An unknown basis must never let a held event through: the SDK drops it (fail closed).
      analytics.failPurposes?.();
      throw err;
    }
    // Always hand the bases over, also when the banner does not render (a visitor who already
    // chose): the SDK's tracking gate needs them to allow a non-consent purpose (#1224).
    analytics.setPurposes?.(purposes);
  };

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration> = {}, text?: string) => {
    const e = doc.createElement(tag);
    Object.assign(e.style, style);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const button = (label: string, primary: boolean) =>
    el(
      'button',
      {
        font: 'inherit',
        padding: '8px 14px',
        borderRadius: '6px',
        cursor: 'pointer',
        border: `1px solid ${accent}`,
        background: primary ? accent : 'transparent',
        color: primary ? '#fff' : 'inherit',
      },
      label,
    );

  const choose = (choice: Consent) => {
    analytics.setConsent(choice);
    if (useGcm && win) gtagOf(win)('consent', 'update', mode({ ...(analytics.consent ?? {}), ...choice }));
    close();
  };
  // A non-consent purpose (legitimate interest, contract) holds until the visitor objects, so an
  // "Accept all" records it too and a "Reject all" records the objection (#1224). It used to be
  // left out and the SDK then dropped every event for it, although the banner said it was on.
  const all = (value: boolean) => Object.fromEntries(purposes.map((p) => [p.key, value]));

  function render() {
    root?.remove();
    root = el('div', {
      position: 'fixed',
      left: '16px',
      right: '16px',
      bottom: '16px',
      maxWidth: '560px',
      margin: '0 auto',
      zIndex: '2147483000',
      padding: '16px',
      borderRadius: '10px',
      boxShadow: '0 6px 24px rgba(0,0,0,.18)',
      background: 'Canvas',
      color: 'CanvasText',
      font: '14px/1.45 system-ui, sans-serif',
    });
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-labelledby', 'am-consent-title');
    root.setAttribute('aria-describedby', 'am-consent-body');
    root.setAttribute('data-am-consent', '');
    const title = el('h2', { margin: '0 0 6px', fontSize: '16px' }, texts.title);
    title.id = 'am-consent-title';
    const body = el('p', { margin: '0 0 10px' }, texts.body);
    body.id = 'am-consent-body';
    root.append(title, body);

    // Per-purpose choices, collapsed until "Choose".
    const list = el('div', { display: 'none', margin: '0 0 10px' });
    const current = analytics.consent ?? {};
    const boxes = new Map<string, HTMLInputElement>();
    for (const p of purposes) {
      const row = el('label', { display: 'flex', gap: '8px', alignItems: 'flex-start', margin: '6px 0' });
      const box = el('input', { marginTop: '3px' });
      box.type = 'checkbox';
      // A purpose that does not need consent is on by default, but the visitor must be able to
      // object: the gateway honours a "no", so the box is offered and checked (#1224).
      box.checked = p.basis === 'consent' ? current[p.key] === true : current[p.key] !== false;
      boxes.set(p.key, box);
      const textCol = el('span');
      textCol.append(
        el('strong', { display: 'block' }, p.basis === 'consent' ? p.name : `${p.name} (${texts.alwaysOn})`),
        el('span', { opacity: '0.8' }, p.description),
      );
      row.append(box, textCol);
      list.append(row);
    }
    root.append(list);

    // Accept and reject are equally prominent: refusing must be as easy as agreeing.
    const actions = el('div', { display: 'flex', flexWrap: 'wrap', gap: '8px' });
    const accept = button(texts.acceptAll, true);
    const reject = button(texts.rejectAll, true);
    const settings = button(texts.settings, false);
    accept.addEventListener('click', () => choose(all(true)));
    reject.addEventListener('click', () => choose(all(false)));
    settings.addEventListener('click', () => {
      if (list.style.display === 'none') {
        list.style.display = 'block';
        settings.textContent = texts.save;
        boxes.values().next().value?.focus();
      } else choose(Object.fromEntries([...boxes].map(([k, b]) => [k, b.checked])));
    });
    actions.append(accept, reject, settings);
    if (opts.privacyUrl) {
      const a = el('a', { alignSelf: 'center', color: 'inherit' }, texts.privacy);
      a.href = opts.privacyUrl;
      actions.append(a);
    }
    root.append(actions);
    doc.body.append(root);
    accept.focus();
  }

  async function open() {
    await loadPurposes().catch(() => {});
    // A workspace may list only non-consent purposes: the banner still opens so the visitor can
    // object, and that choice is recorded. It used to never open and then nothing was ever sent.
    if (!purposes.length) return;
    render();
  }
  function close() {
    root?.remove();
    root = null;
  }

  // Any element with data-am-consent-open (e.g. a "Cookie settings" footer link) reopens it.
  doc.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (t?.closest?.('[data-am-consent-open]')) {
      e.preventDefault();
      void open();
    }
  });

  // Load the purpose bases even when the banner stays closed (a visitor who already chose): the SDK
  // needs them to allow a non-consent tracking purpose (#1224).
  const ready = analytics.consent === null || opts.open ? open() : loadPurposes().catch(() => {});
  return {
    open,
    close,
    /** Resolves once the banner is shown (or skipped because the visitor already chose). */
    ready,
    get element() {
      return root;
    },
  };
}
