import { describe, expect, it } from 'vitest';
import { compare } from '../src/results';

describe('experiment statistics', () => {
  it('computes lift, a two-sided p-value and the interval of the difference', () => {
    const r = compare({ exposed: 1000, converted: 100 }, { exposed: 1000, converted: 130 });
    expect(r.lift).toBeCloseTo(0.3, 5);
    // Pooled z ≈ 2.10 → p ≈ 0.036.
    expect(r.pValue).toBeGreaterThan(0.03);
    expect(r.pValue).toBeLessThan(0.042);
    expect(r.ci95![0]).toBeGreaterThan(0);
    expect(compare({ exposed: 1000, converted: 100 }, { exposed: 1000, converted: 101 }).pValue).toBeGreaterThan(0.9);
    expect(compare({ exposed: 0, converted: 0 }, { exposed: 10, converted: 1 })).toEqual({ lift: null, pValue: null, ci95: null });
  });
});
