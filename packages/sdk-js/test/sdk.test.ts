import { describe, expect, it } from 'vitest';
import { createAnalytics } from '../src';

function harness(status = 200) {
  const sent: any[] = [];
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response('{}', { status });
  }) as typeof globalThis.fetch;
  const page = () => ({ path: '/tents', url: 'https://shop.example.com/tents', title: 'Tents', referrer: '' });
  const make = () =>
    createAnalytics({ writeKey: 'pk_test', host: 'https://collect.example.com', fetch, storage, page, flushInterval: 10_000 });
  return { sent, data, make, events: () => sent.flatMap((b) => b.batch) };
}

describe('sdk-js', () => {
  it('sends and stores nothing before the visitor chooses, then releases the queue on yes', async () => {
    const h = harness();
    const a = h.make();
    a.page('Tents');
    a.track('Product Viewed', { sku: 'TENT-2' });
    await a.flush();
    expect(h.sent).toEqual([]);
    expect(h.data.size).toBe(0);

    a.setConsent({ analytics: true, marketing_email: false });
    await a.flush();
    const names = h.events().map((e) => e.event ?? e.name);
    expect(names).toEqual(['Segment Consent Preference Updated', 'Tents', 'Product Viewed']);
    for (const e of h.events()) {
      expect(e.anonymousId).toBe(a.anonymousId);
      expect(e.context.consent.categoryPreferences).toEqual({ analytics: true, marketing_email: false });
      expect(e.context.page.path).toBe('/tents');
    }
    expect(h.data.get('am.aid')).toBe(a.anonymousId);
  });

  it('discards the queue on no, but still reports the choice', async () => {
    const h = harness();
    const a = h.make();
    a.track('Product Viewed');
    a.setConsent({ analytics: false });
    a.track('Product Viewed');
    await a.flush();
    expect(h.events().map((e) => e.event)).toEqual(['Segment Consent Preference Updated']);
    expect(h.data.has('am.aid')).toBe(false);
    expect(h.data.get('am.consent')).toBe('{"analytics":false}');
  });

  it('remembers the choice and ids across page loads, and forgets ids when consent is withdrawn', async () => {
    const h = harness();
    const first = h.make();
    first.setConsent({ analytics: true });
    first.identify('u-42', { plan: 'pro' });
    const second = h.make();
    expect(second.consent).toEqual({ analytics: true });
    expect(second.anonymousId).toBe(first.anonymousId);
    second.track('Signed In');
    await second.flush();
    expect(h.events().at(-1)).toMatchObject({ event: 'Signed In', userId: 'u-42' });

    second.setConsent({ analytics: false });
    expect(h.data.has('am.aid')).toBe(false);
    expect(h.data.has('am.uid')).toBe(false);
  });

  it('keeps events for a retry when the collector fails', async () => {
    const h = harness(503);
    const a = h.make();
    a.setConsent({ analytics: true });
    a.track('Order Completed');
    await a.flush();
    const tries = h.sent.length;
    await a.flush();
    expect(h.sent.length).toBe(tries + 1);
    expect(h.sent.at(-1).batch.map((e: any) => e.event)).toEqual(['Segment Consent Preference Updated', 'Order Completed']);
  });
});
