import { describe, expect, it } from 'vitest';
import { billingReservationTtlMs, stepBudget, tokensOfSteps } from '../src/providers';

// The turn/run budget arithmetic behind #356: a turn reserves an allowance, counts every step's
// input and output against it, and refuses the next model call before it is made when the room
// left cannot pay for a useful step.

const step = (inputTokens: number, outputTokens: number) => ({ usage: { inputTokens, outputTokens } });

describe('tokensOfSteps', () => {
  it('adds the input and output of every completed step', () => {
    expect(tokensOfSteps([step(100, 20), step(300, 40)])).toBe(460);
  });

  it('treats a provider that omits a count as zero', () => {
    expect(tokensOfSteps([{ usage: {} }, { usage: { inputTokens: 7 } }])).toBe(7);
  });
});

describe('stepBudget', () => {
  it('caps the next step at what is left of the allowance', () => {
    expect(stepBudget({ allowance: 20_000, used: 15_500, maxOutputTokens: 2_000 })).toEqual({
      stop: false,
      maxOutputTokens: 2_000,
    });
    expect(stepBudget({ allowance: 20_000, used: 19_000, maxOutputTokens: 2_000 })).toEqual({
      stop: false,
      maxOutputTokens: 1_000,
    });
  });

  it('takes the estimated prompt of the next step out of the room first', () => {
    // 6,000 left, but the next prompt is about 5,000: only 1,000 may be written.
    expect(stepBudget({ allowance: 20_000, used: 14_000, maxOutputTokens: 2_000, estimatedInput: 5_000 })).toEqual({
      stop: false,
      maxOutputTokens: 1_000,
    });
  });

  it('stops before the call when the allowance is used up', () => {
    expect(stepBudget({ allowance: 20_000, used: 20_000, maxOutputTokens: 2_000 })).toEqual({
      stop: true,
      maxOutputTokens: 1,
    });
    expect(stepBudget({ allowance: 20_000, used: 19_950, maxOutputTokens: 2_000 }).stop).toBe(true);
  });

  it('stops when the next prompt alone would leave no room for a useful answer', () => {
    expect(stepBudget({ allowance: 20_000, used: 10_000, maxOutputTokens: 2_000, estimatedInput: 9_950 }).stop).toBe(true);
  });

  it('never returns a zero output cap', () => {
    const budget = stepBudget({ allowance: 1_000, used: 0, maxOutputTokens: 0 });
    expect(budget.maxOutputTokens).toBe(1);
  });
});

describe('a capped turn', () => {
  it('cannot record more than its allowance when each step uses its cap', () => {
    const allowance = 20_000;
    const maxOutputTokens = 2_000;
    // An honest prompt estimate: the fake model reports exactly the tokens it was sent, and the
    // prompt grows a little with every tool result.
    let used = 0;
    let prompt = 900;
    let steps = 0;
    for (;;) {
      const budget = stepBudget({ allowance, used, maxOutputTokens, estimatedInput: prompt });
      if (budget.stop) break;
      // The provider reports the prompt it was sent plus the whole output cap it was given.
      used += prompt + budget.maxOutputTokens;
      prompt += 250;
      steps++;
      expect(used).toBeLessThanOrEqual(allowance);
      expect(steps).toBeLessThan(100);
    }
    expect(steps).toBeGreaterThan(1);
    expect(used).toBeLessThanOrEqual(allowance);
    // The loop stopped before another call because the room left could not pay for a step.
    expect(stepBudget({ allowance, used, maxOutputTokens, estimatedInput: prompt }).stop).toBe(true);
  });

  it('stops a 21k month at the 20k turn cap instead of the old 12-step overshoot', () => {
    const allowance = 20_000;
    const maxOutputTokens = 2_000;
    let used = 0;
    let steps = 0;
    // The old loop: 12 steps of 2,000 output alone would have been 24,000 tokens.
    while (steps < 12) {
      const budget = stepBudget({ allowance, used, maxOutputTokens, estimatedInput: 100 });
      if (budget.stop) break;
      used += 100 + budget.maxOutputTokens;
      steps++;
    }
    expect(steps).toBeLessThan(12);
    expect(used).toBeLessThanOrEqual(21_000);
    expect(used).toBeLessThanOrEqual(allowance);
  });
});

describe('pre-call billing coverage', () => {
  it('survives a database outage and a call crossing UTC month-end', () => {
    const now = new Date('2028-01-31T23:59:59Z');
    expect(new Date(now.getTime() + billingReservationTtlMs(now)).toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });
});
