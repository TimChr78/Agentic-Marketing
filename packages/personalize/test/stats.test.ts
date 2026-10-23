import { describe, expect, it } from 'vitest';
import { bayesian, compare, sequentialP } from '../src/results';

// Experiment statistics as pure functions: the sequential p-value and the Bayesian figures agree
// with what the counts say, and stay put when nothing differs.

const arm = (exposed: number, converted: number) => ({ exposed, converted });

describe('sequential (always-valid) p-values', () => {
  it('stay near 1 for equal arms and fall for a clear difference', () => {
    expect(sequentialP(arm(5000, 500), arm(5000, 500))).toBeGreaterThan(0.9);
    expect(sequentialP(arm(5000, 500), arm(5000, 650))).toBeLessThan(0.01);
  });

  it('are more cautious than the fixed-horizon p-value for the same counts', () => {
    const c = arm(2000, 200);
    const v = arm(2000, 245);
    expect(sequentialP(c, v)!).toBeGreaterThan(compare(c, v).pValue!);
  });

  it('do not call small samples', () => {
    expect(sequentialP(arm(40, 4), arm(40, 9))).toBeGreaterThan(0.05);
    expect(sequentialP(arm(0, 0), arm(10, 1))).toBeNull();
  });
});

describe('Bayesian figures', () => {
  it('give about even odds for equal arms, and high odds for a better one', () => {
    const even = bayesian(
      [
        { variant: 'holdout', ...arm(3000, 300) },
        { variant: 'b', ...arm(3000, 300) },
      ],
      'holdout',
    );
    expect(even.get('b')!.probBeatControl!).toBeGreaterThan(0.4);
    expect(even.get('b')!.probBeatControl!).toBeLessThan(0.6);
    const clear = bayesian(
      [
        { variant: 'holdout', ...arm(3000, 300) },
        { variant: 'b', ...arm(3000, 390) },
      ],
      'holdout',
    );
    expect(clear.get('b')!.probBeatControl!).toBeGreaterThan(0.99);
    expect(clear.get('b')!.probBest).toBeGreaterThan(0.99);
    expect(clear.get('holdout')!.expectedLoss).toBeGreaterThan(clear.get('b')!.expectedLoss);
  });

  it('are the same every time for the same counts', () => {
    const rows = [
      { variant: 'a', ...arm(800, 60) },
      { variant: 'b', ...arm(800, 75) },
      { variant: 'c', ...arm(800, 70) },
    ];
    expect([...bayesian(rows, 'a')]).toEqual([...bayesian(rows, 'a')]);
    const total = [...bayesian(rows, 'a').values()].reduce((s, x) => s + x.probBest, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});
