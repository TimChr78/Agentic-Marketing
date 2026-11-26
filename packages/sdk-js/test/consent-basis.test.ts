import { Window as HappyWindow } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { createAnalytics, createConsentBanner } from '../src';

// #1224: a web purpose may be published on a non-consent basis (legitimate interest or contract).
// The gateway keeps such a purpose's events unless the visitor refused it (`consentAllows`), but the
// banner used to label it "Always on" without ever recording it, and `createAnalytics` dropped every
// event until `consent[trackingPurpose] === true`. The three parts of the product now agree.

function harness(storedConsent?: string) {
  const sent: any[] = [];
  const data = new Map<string, string>();
  if (storedConsent) data.set('am.consent', storedConsent);
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response('{}');
  }) as typeof globalThis.fetch;
  const analytics = createAnalytics({
    writeKey: 'pk_test',
    host: 'https://am.example.com',
    fetch,
    storage,
    page: () => ({ path: '/', url: 'https://shop.example.com/', title: 'Home', referrer: '' }),
    flushInterval: 10_000,
  });
  return { analytics, sent, data, events: () => sent.flatMap((b) => b.batch) };
}

const legitimateInterest = [
  {
    key: 'analytics',
    name: 'Analytics',
    description: 'How the site is used.',
    basis: 'legitimate_interest',
  },
  {
    key: 'web_personalization',
    name: 'Personalization',
    description: 'Tailoring the site to you.',
    basis: 'consent',
  },
];

describe('a tracking purpose on a non-consent basis (#1224)', () => {
  it('is recorded by the banner and its events are sent, like the gateway keeps them', async () => {
    const win = new HappyWindow({ url: 'https://shop.example.com/' }) as unknown as Window;
    const doc = win.document;
    const h = harness();
    const banner = createConsentBanner(h.analytics, { purposes: legitimateInterest, document: doc });
    await banner.ready;
    const root = doc.querySelector('[data-am-consent]')!;
    expect(root.textContent).toContain('Analytics (Always on)');

    ([...root.querySelectorAll('button')].find((b) => b.textContent === 'Accept all') as HTMLButtonElement).click();
    // The legitimate-interest purpose is on by default, and accepting records it instead of leaving
    // the SDK's tracking gate to drop everything.
    expect(h.analytics.consent).toEqual({ analytics: true, web_personalization: true });

    h.analytics.page('Home');
    h.analytics.track('Signed up');
    await h.analytics.flush();
    const events = h.events();
    expect(events.some((e) => e.event === 'Segment Consent Preference Updated')).toBe(true);
    expect(events.some((e) => e.type === 'page' && e.name === 'Home')).toBe(true);
    expect(events.some((e) => e.event === 'Signed up')).toBe(true);
  });

  it('is refused when the visitor rejects all, so no event leaves the browser', async () => {
    const win = new HappyWindow({ url: 'https://shop.example.com/' }) as unknown as Window;
    const doc = win.document;
    const h = harness();
    const banner = createConsentBanner(h.analytics, { purposes: legitimateInterest, document: doc });
    await banner.ready;
    const root = doc.querySelector('[data-am-consent]')!;
    ([...root.querySelectorAll('button')].find((b) => b.textContent === 'Reject all') as HTMLButtonElement).click();
    expect(h.analytics.consent).toEqual({ analytics: false, web_personalization: false });

    h.analytics.page('Home');
    await h.analytics.flush();
    expect(h.events().map((e) => e.event ?? e.type)).toEqual(['Segment Consent Preference Updated']);
  });

  it('offers the non-consent purpose as an objectable box, not a disabled one', async () => {
    const win = new HappyWindow({ url: 'https://shop.example.com/' }) as unknown as Window;
    const doc = win.document;
    const h = harness();
    const banner = createConsentBanner(h.analytics, { purposes: legitimateInterest, document: doc });
    await banner.ready;
    const boxes = [...doc.querySelectorAll('[data-am-consent] input')] as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, false],
    ]);
    // Unchecking the legitimate-interest purpose records the objection.
    boxes[0].checked = false;
    const choose = [...doc.querySelectorAll('[data-am-consent] button')].find((b) => b.textContent === 'Choose') as HTMLButtonElement;
    choose.click(); // shows the list
    choose.click(); // saves
    expect(h.analytics.consent).toEqual({ analytics: false, web_personalization: false });
  });

  it('lets the SDK gate follow the basis it was told, so a returning visitor is not dropped', async () => {
    // A choice stored before the workspace listed `analytics` holds no entry for it. With the basis
    // known, the tracking purpose holds unless the visitor refused; a consent-basis purpose does
    // not, which is the gateway's rule too.
    const h = harness(JSON.stringify({ web_personalization: true }));
    h.analytics.setPurposes([
      { key: 'analytics', basis: 'legitimate_interest' },
      { key: 'web_personalization', basis: 'consent' },
    ]);
    h.analytics.track('Held by legitimate interest');
    await h.analytics.flush();
    expect(h.events().map((e) => e.event)).toContain('Held by legitimate interest');

    const consent = harness(JSON.stringify({ web_personalization: true }));
    // Without a known basis an unknown purpose needs an explicit yes, as before.
    consent.analytics.track('Unknown basis');
    await consent.analytics.flush();
    expect(consent.events()).toHaveLength(0);
  });

  it('still allows nothing before the visitor has chosen', async () => {
    const h = harness();
    h.analytics.setPurposes([{ key: 'analytics', basis: 'legitimate_interest' }]);
    h.analytics.track('Before a choice');
    await h.analytics.flush();
    expect(h.events()).toHaveLength(0);
    h.analytics.setConsent({});
    h.analytics.track('After a choice');
    await h.analytics.flush();
    expect(h.events().map((e) => e.event)).toContain('After a choice');
  });
});
