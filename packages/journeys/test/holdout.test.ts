import { describe, expect, it } from 'vitest';
import { analyseHoldout, armFor, holdoutHashVersion, newcombeDifference, wilsonInterval } from '../src/holdout';

// Assignment is a pure function of the scope; the statistics are the same Newcombe interval the
// command reports. Hand-computed examples pin the numbers, so a refactor cannot quietly change
// what a "clear" result means.

const workspace = '00000000-0000-0000-0000-000000000001';
const journey = 'jrn_0123456789abcdef0123456789abcdef';

describe('deterministic holdout assignment', () => {
  it('gives the same person the same arm every time', () => {
    const hash = holdoutHashVersion(10);
    expect(armFor(10, workspace, journey, hash, 'prf_abc')).toBe(armFor(10, workspace, journey, hash, 'prf_abc'));
  });

  it('splits about the percentage over many synthetic profiles', () => {
    const hash = holdoutHashVersion(10);
    let control = 0;
    const total = 10_000;
    for (let i = 0; i < total; i++) if (armFor(10, workspace, journey, hash, `prf_${i}`) === 'control') control++;
    expect(control / total).toBeGreaterThan(0.09);
    expect(control / total).toBeLessThan(0.11);
  });

  it('changes the scope when the percentage changes', () => {
    expect(holdoutHashVersion(10)).not.toBe(holdoutHashVersion(20));
    expect(holdoutHashVersion(10)).toBe(holdoutHashVersion(10));
  });
});

describe('confidence interval', () => {
  it('matches a hand-computed Wilson interval', () => {
    // 100/500 = 0.2: centre and half-width from the Wilson formula with z = 1.96.
    const [low, high] = wilsonInterval(100, 500)!;
    expect(low).toBeCloseTo(0.1672855, 6);
    expect(high).toBeCloseTo(0.2372891, 6);
  });

  it('matches a hand-computed Newcombe difference (10% control vs 30% treatment of 100)', () => {
    // Wilson 95% control [0.0555, 0.1744], treatment [0.2186, 0.3955]; d = 0.2.
    const [low, high] = newcombeDifference({ converted: 10, entered: 100 }, { converted: 30, entered: 100 })!;
    expect(low).toBeCloseTo(0.0900021, 6);
    expect(high).toBeCloseTo(0.3057893, 6);
  });

  it('is null without both samples', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(newcombeDifference({ converted: 0, entered: 0 }, { converted: 5, entered: 10 })).toBeNull();
  });
});

describe('holdout verdict', () => {
  it('reports rates, lift and a clear winner once both samples are met', () => {
    const out = analyseHoldout({ entered: 100, converted: 10, unsubscribed: 0 }, { entered: 100, converted: 30, unsubscribed: 2 }, 100);
    expect(out.control.conversionRate).toBeCloseTo(0.1, 10);
    expect(out.treatment.conversionRate).toBeCloseTo(0.3, 10);
    expect(out.absoluteLift).toBeCloseTo(0.2, 10);
    expect(out.relativeLift).toBeCloseTo(2, 10);
    expect(out.ci95![0]).toBeCloseTo(0.0900021, 6);
    expect(out.ci95![1]).toBeCloseTo(0.3057893, 6);
    expect(out.treatment.unsubscribeRate).toBeCloseTo(0.02, 10);
    expect(out.minSampleSizeMet).toBe(true);
    expect(out.verdict).toBe('treatment_better');
  });

  it('calls a harmful journey worse only when the interval excludes zero', () => {
    const out = analyseHoldout({ entered: 100, converted: 20, unsubscribed: 0 }, { entered: 100, converted: 10, unsubscribed: 0 }, 100);
    expect(out.ci95![1]).toBeLessThan(0);
    expect(out.verdict).toBe('treatment_worse');
  });

  it('does not invent a difference for identical arms', () => {
    const out = analyseHoldout({ entered: 500, converted: 50, unsubscribed: 0 }, { entered: 500, converted: 50, unsubscribed: 0 }, 200);
    expect(out.absoluteLift).toBe(0);
    expect(out.ci95![0]).toBeLessThan(0);
    expect(out.ci95![1]).toBeGreaterThan(0);
    expect(out.verdict).toBe('no_clear_difference');
  });

  it('says not enough data below the minimum in either arm', () => {
    const out = analyseHoldout({ entered: 99, converted: 10, unsubscribed: 0 }, { entered: 400, converted: 120, unsubscribed: 0 }, 100);
    expect(out.minSampleSizeMet).toBe(false);
    expect(out.verdict).toBe('not_enough_data');
  });
});
