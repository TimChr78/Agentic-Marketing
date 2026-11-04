import { describe, expect, it } from 'vitest';
import { type AnalyticsOptions, createAnalytics } from '../src';

function harness(status = 200) {
  const sent: any[] = [];
  const data = new Map<string, string>();
  let current = status;
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response('{}', { status: current });
  }) as typeof globalThis.fetch;
  const page = () => ({ path: '/tents', url: 'https://shop.example.com/tents', title: 'Tents', referrer: '' });
  const make = (extra: Partial<AnalyticsOptions> = {}) =>
    createAnalytics({
      writeKey: 'pk_test',
      host: 'https://collect.example.com',
      fetch,
      storage,
      page,
      flushInterval: 10_000,
      ...extra,
    });
  return { sent, data, make, setStatus: (s: number) => (current = s), events: () => sent.flatMap((b) => b.batch) };
}

describe('sdk-js', () => {
  it('forgets the user id on reset even while analytics stays allowed', async () => {
    const h = harness();
    const a = h.make();
    a.setConsent({ analytics: true });
    a.identify('alice');
    await a.flush();
    expect(h.data.get('am.uid')).toBe('alice');

    a.reset();
    await a.flush();
    expect(h.data.has('am.uid')).toBe(false);

    const b = h.make();
    b.track('After logout');
    await b.flush();
    expect(h.events().at(-1).event).toBe('After logout');
    expect(h.events().at(-1).userId).toBeUndefined();
  });

  it('discards events queued under a grant when consent is withdrawn, keeping the consent update', async () => {
    const h = harness();
    const a = h.make();
    a.setConsent({ analytics: true });
    await a.flush();
    a.track('Queued before refusal');
    a.setConsent({ analytics: false });
    await a.flush();

    expect(h.events().some((e) => e.event === 'Queued before refusal')).toBe(false);
    const consentEvents = h.events().filter((e) => e.event === 'Segment Consent Preference Updated');
    expect(consentEvents.at(-1).context.consent.categoryPreferences).toEqual({ analytics: false });
  });

  it('does not retry a failed batch after consent is withdrawn', async () => {
    const h = harness(503);
    const a = h.make();
    a.setConsent({ analytics: true });
    await a.flush();
    a.track('Failed under grant');
    await a.flush(); // rejected and requeued
    const attempts = h.sent.length;
    h.setStatus(200);
    a.setConsent({ analytics: false });
    await a.flush();

    const afterWithdrawal = h.sent.slice(attempts).flatMap((b) => b.batch);
    expect(afterWithdrawal.some((e) => e.event === 'Failed under grant')).toBe(false);
  });

  it('keeps the page-hide batch when the beacon is rejected, in order, and recovers with fetch', async () => {
    const previous = {
      listener: Object.getOwnPropertyDescriptor(globalThis, 'addEventListener'),
      document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    };
    let hidden: (() => void) | undefined;
    (globalThis as any).addEventListener = (type: string, fn: () => void) => {
      if (type === 'visibilitychange') hidden = fn;
    };
    (globalThis as any).document = { visibilityState: 'hidden', title: '', cookie: '' };
    try {
      const h = harness();
      let beacons = 0;
      const a = h.make({
        sendBeacon: () => {
          beacons += 1;
          return false;
        },
      });
      a.setConsent({ analytics: true });
      await a.flush();
      a.track('First hidden event');
      a.track('Second hidden event');

      hidden!();
      await a.flush();

      expect(beacons).toBe(1);
      expect(
        h
          .events()
          .map((e) => e.event)
          .slice(-2),
      ).toEqual(['First hidden event', 'Second hidden event']);
    } finally {
      if (previous.listener) Object.defineProperty(globalThis, 'addEventListener', previous.listener);
      else delete (globalThis as any).addEventListener;
      if (previous.document) Object.defineProperty(globalThis, 'document', previous.document);
      else delete (globalThis as any).document;
    }
  });

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
