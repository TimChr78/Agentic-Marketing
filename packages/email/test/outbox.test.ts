import { describe, expect, it } from 'vitest';
import { retryDelaySeconds } from '../src/outbox';

describe('retry schedule', () => {
  it('retries transactional mail in seconds, then falls back to the normal backoff', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelaySeconds('transactional', n))).toEqual([10, 30, 60, 120, 750]);
  });

  it('keeps the old backoff for marketing', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelaySeconds('marketing', n))).toEqual([30, 120, 270, 480, 750]);
  });
});
