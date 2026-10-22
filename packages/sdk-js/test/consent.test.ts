import { Window as HappyWindow } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { captureClickIds, createAnalytics, createConsentBanner } from '../src';

function harness(landing = { search: '', cookies: '' }) {
  const sent: any[] = [];
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response('{}');
  }) as typeof globalThis.fetch;
  const page = () => ({ path: '/', url: 'https://martechsignal.com/', title: 'Home', referrer: '' });
  const make = () =>
    createAnalytics({
      writeKey: 'pk_test',
      host: 'https://am.example.com',
      fetch,
      storage,
      page,
      landing: () => landing,
      flushInterval: 10_000,
    });
  return { data, make, events: () => sent.flatMap((b) => b.batch) };
}

describe('ad click ids', () => {
  it('reads landing parameters and Meta cookies', () => {
    expect(captureClickIds('?gclid=Cj0KCQabc&utm_source=google', '', 1_700_000_000_000)).toEqual({ gclid: 'Cj0KCQabc' });
    expect(captureClickIds('?fbclid=IwAR123abc', '_fbp=fb.1.1690000000000.123456; other=1', 1_700_000_000_000)).toEqual({
      fbc: 'fb.1.1700000000000.IwAR123abc',
      fbp: 'fb.1.1690000000000.123456',
    });
    expect(captureClickIds('?msclkid=<script>', '')).toEqual({});
  });

  it('sends and keeps them only with ad_measurement allowed', async () => {
    const h = harness({ search: '?gclid=Cj0KCQabc', cookies: '' });
    const a = h.make();
    a.setConsent({ analytics: true, ad_measurement: false });
    a.page();
    await a.flush();
    expect(h.events().some((e) => e.context.clickIds)).toBe(false);
    expect(h.data.has('am.clk')).toBe(false);

    a.setConsent({ ad_measurement: true });
    a.page();
    await a.flush();
    expect(h.events().at(-1).context.clickIds).toEqual({ gclid: 'Cj0KCQabc' });
    expect(JSON.parse(h.data.get('am.clk')!)).toEqual({ gclid: 'Cj0KCQabc' });

    a.setConsent({ ad_measurement: false });
    expect(h.data.has('am.clk')).toBe(false);
  });
});

describe('consent banner', () => {
  const purposes = [
    { key: 'necessary', name: 'Strictly necessary', description: 'Running the site.', basis: 'contract' },
    { key: 'analytics', name: 'Analytics', description: 'How the site is used.', basis: 'consent' },
    { key: 'ad_measurement', name: 'Ad measurement', description: 'Which ads work.', basis: 'consent' },
  ];
  function setup(consent: Record<string, boolean> | null = null) {
    const win = new HappyWindow({ url: 'https://martechsignal.com/' }) as unknown as Window & { dataLayer?: unknown[] };
    const choices: Record<string, boolean>[] = [];
    let current = consent;
    const analytics = {
      get consent() {
        return current;
      },
      host: 'https://am.example.com',
      writeKey: 'pk_test',
      setConsent(c: Record<string, boolean>) {
        choices.push(c);
        current = { ...(current ?? {}), ...c };
      },
    };
    return { win, doc: win.document, analytics, choices };
  }
  const gcm = (win: { dataLayer?: unknown[] }) => (win.dataLayer ?? []).map((a) => Array.from(a as ArrayLike<unknown>));

  it('asks until the visitor chooses, with reject as easy as accept, and tells Google', async () => {
    const { win, doc, analytics, choices } = setup();
    const banner = createConsentBanner(analytics, { purposes, document: doc });
    await banner.ready;
    const root = doc.querySelector('[data-am-consent]')!;
    expect(root.getAttribute('role')).toBe('dialog');
    const buttons = [...root.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Accept all', 'Reject all', 'Choose']);
    expect(gcm(win)[0]).toEqual([
      'consent',
      'default',
      { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', wait_for_update: 500 },
    ]);

    (root.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(choices).toEqual([{ analytics: false, ad_measurement: false }]);
    expect(doc.querySelector('[data-am-consent]')).toBeNull();
    expect(gcm(win)[1][1]).toBe('update');
  });

  it('lets the visitor choose per purpose, and reopens from a settings link', async () => {
    const { win, doc, analytics, choices } = setup({ analytics: true });
    doc.body.innerHTML = '<a href="#" data-am-consent-open>Cookie settings</a>';
    const banner = createConsentBanner(analytics, { purposes, document: doc });
    await banner.ready;
    expect(doc.querySelector('[data-am-consent]')).toBeNull(); // already chosen

    (doc.querySelector('[data-am-consent-open]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const root = doc.querySelector('[data-am-consent]')!;
    const boxes = [...root.querySelectorAll('input')] as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    const choose = root.querySelectorAll('button')[2] as HTMLButtonElement;
    choose.click(); // expands
    boxes[2].checked = true;
    boxes[1].checked = false;
    choose.click(); // saves
    expect(choices.at(-1)).toEqual({ analytics: false, ad_measurement: true });
    expect(gcm(win).at(-1)).toEqual([
      'consent',
      'update',
      { analytics_storage: 'denied', ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied' },
    ]);
  });
});
