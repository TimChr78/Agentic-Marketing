import { describe, expect, it } from 'vitest';
import { allocate, type DecideContext, deviceOf, matches } from '../src/targeting';

const seg = `seg_${'1'.repeat(32)}`;
const base: DecideContext = {
  personalized: true,
  snapshot: { profileId: 'prf_1', traits: { tier: 'gold', orders: 3 }, segments: [seg], at: '' },
  session: {
    pageViews: 3,
    firstSeen: 'x',
    lastPath: '/tents',
    referrer: null,
    utmSource: null,
    counts: { 'Product Viewed': 2 },
    isNew: false,
  },
  page: { url: 'https://shop.example.com/tents?utm_source=newsletter', path: '/tents', referrer: 'https://google.com' },
  utmSource: 'newsletter',
  device: 'desktop',
};

describe('decide targeting', () => {
  it('evaluates people and page conditions', () => {
    expect(
      matches(
        { all: [{ segment: seg }, { trait: 'orders', op: 'gte', value: 2 }, { session: 'Product Viewed', count: { gte: 2 } }] },
        base,
      ),
    ).toBe(true);
    expect(matches({ trait: 'tier', op: 'in', value: ['silver', 'gold'] }, base)).toBe(true);
    expect(matches({ page: { pathPrefix: '/tent' } }, base)).toBe(true);
    expect(matches({ any: [{ utmSource: 'ads' }, { referrer: { contains: 'google' } }] }, base)).toBe(true);
    expect(matches({ newVisitor: true }, base)).toBe(false);
  });

  it('without personalization consent, uses only the page, and never turns "not personal" into true', () => {
    const anon = { ...base, personalized: false };
    expect(matches({ segment: seg }, anon)).toBe(false);
    expect(matches({ not: { segment: seg } }, anon)).toBe(false);
    expect(matches({ page: { path: '/tents' } }, anon)).toBe(true);
    expect(matches({ not: { device: 'mobile' } }, anon)).toBe(true);
  });

  it('allocates stickily, by weight, with a holdout', () => {
    const e = {
      variants: [
        { id: 'a', name: 'A', weight: 50, content: { html: 'A' } },
        { id: 'b', name: 'B', weight: 50, content: { html: 'B' } },
      ],
      holdoutPercent: 20,
    };
    const counts: Record<string, number> = { a: 0, b: 0, holdout: 0 };
    for (let i = 0; i < 5000; i++) counts[allocate('exp_1', `p${i}`, e)?.id ?? 'holdout']++;
    expect(counts.holdout / 5000).toBeGreaterThan(0.17);
    expect(counts.holdout / 5000).toBeLessThan(0.23);
    expect(Math.abs(counts.a - counts.b) / 4000).toBeLessThan(0.06);
    expect(allocate('exp_1', 'same', e)?.id).toBe(allocate('exp_1', 'same', e)?.id);
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('mobile');
  });
});
