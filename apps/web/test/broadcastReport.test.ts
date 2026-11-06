import { describe, expect, it } from 'vitest';
import { reportViewOf } from '../src/features/broadcasts/BroadcastReport';
import { analyticsHrefFor, lastSevenLocalDays } from '../src/features/broadcasts/period';

// A suppressed or unavailable measure is null, not an observed zero. Only a real sent=0 is "No
// sends"; the rate tile names the denominator it actually has.

const values = (
  overrides: Partial<Record<'email.sent' | 'email.delivered' | 'email.clicked' | 'email.click_rate', number | null>> = {},
) => ({
  'email.sent': 100,
  'email.delivered': 90,
  'email.clicked': 10,
  'email.click_rate': 10 / 90,
  ...overrides,
});

describe('Broadcast report data states (#449 review)', () => {
  it('null (unavailable) is not an empty send', () => {
    const view = reportViewOf(values({ 'email.sent': null, 'email.delivered': null, 'email.clicked': null, 'email.click_rate': null }), 0);
    expect(view.noSends).toBe(false);
    expect(view.rateAvailable).toBe(false);
    expect(view.rateDataState).toBe('no-data');
    expect(view.rateExplanation).toBe('Unavailable in this period');
    expect(view.countExplanation(null)).toBe('Unavailable in this period');
  });

  it('suppressed data keeps the suppression explanation', () => {
    const view = reportViewOf(values({ 'email.sent': null, 'email.delivered': null, 'email.clicked': null, 'email.click_rate': null }), 3);
    expect(view.noSends).toBe(false);
    expect(view.rateDataState).toBe('suppressed');
    expect(view.rateExplanation).toBe('Suppressed · fewer than 5 people');
    expect(view.countExplanation(null)).toBe('Suppressed · fewer than 5 people');
  });

  it('an observed zero sent is the only no-sends state', () => {
    const view = reportViewOf(values({ 'email.sent': 0, 'email.delivered': 0, 'email.clicked': 0, 'email.click_rate': null }), 0);
    expect(view.noSends).toBe(true);
    expect(view.rateExplanation).toBe('No sends in this period');
  });

  it('a real zero denominator is named as such only when there were sends', () => {
    const view = reportViewOf(values({ 'email.sent': 100, 'email.delivered': 0, 'email.clicked': 0, 'email.click_rate': null }), 0);
    expect(view.noSends).toBe(false);
    expect(view.rateAvailable).toBe(false);
    expect(view.rateExplanation).toBe('No delivered people to divide by');
  });

  it('emits the same date-only, inclusive Analytics link format Home uses', () => {
    const period = lastSevenLocalDays(new Date('2026-11-06T12:00:00Z'), 'UTC');
    const broadcast = `bct_${'a'.repeat(32)}`;
    expect(analyticsHrefFor(period, broadcast)).toBe(`/insights/analytics?from=2026-10-30&to=2026-11-05&broadcast=${broadcast}`);
  });
});
