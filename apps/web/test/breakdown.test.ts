import { describe, expect, it } from 'vitest';
import { hasBreakdown } from '../src/lib/breakdown';

describe('analytics breakdown (#442 review)', () => {
  it('treats the currency the compiler adds to revenue as a breakdown', () => {
    // Day + revenue: rows such as 2026-11-01/USD and 2026-11-01/EUR must not become one line.
    expect(
      hasBreakdown([
        { name: 'day', kind: 'dimension' },
        { name: 'currency', kind: 'dimension' },
        { name: 'conversion.revenue', kind: 'measure' },
      ]),
    ).toBe(true);
  });

  it('charts a plain time series', () => {
    expect(
      hasBreakdown([
        { name: 'day', kind: 'dimension' },
        { name: 'email.sent', kind: 'measure' },
        { name: 'email.click_rate', kind: 'measure' },
      ]),
    ).toBe(false);
  });

  it('treats a chosen breakdown such as broadcast as one', () => {
    expect(
      hasBreakdown([
        { name: 'day', kind: 'dimension' },
        { name: 'broadcast', kind: 'dimension' },
        { name: 'email.sent', kind: 'measure' },
      ]),
    ).toBe(true);
  });
});
