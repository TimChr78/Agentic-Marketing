import { describe, expect, it } from 'vitest';
import { testPort } from './harness';

// #990 follow-up: experience-rollout (base 3 600) and password-reset (base 2 600 in the next
// worker, +1 000) both listened on 3 600 in CI, and one failed with EADDRINUSE inside beforeAll.
// The per-worker stride must separate every pair of bases the server tests use, including bases
// that differ by exactly the old stride.
describe('testPort', () => {
  it('gives each worker a block that cannot overlap another worker’s', () => {
    const saved = process.env.VITEST_POOL_ID;
    try {
      const ports: number[] = [];
      for (let pool = 1; pool <= 4; pool++) {
        process.env.VITEST_POOL_ID = String(pool);
        for (let base = 2_500; base < 4_700; base += 1) ports.push(testPort(base));
      }
      expect(new Set(ports).size).toBe(ports.length);
    } finally {
      if (saved === undefined) delete process.env.VITEST_POOL_ID;
      else process.env.VITEST_POOL_ID = saved;
    }
  });

  it('keeps the old pair apart', () => {
    const saved = process.env.VITEST_POOL_ID;
    try {
      process.env.VITEST_POOL_ID = '1';
      const rollout = testPort(3_600);
      process.env.VITEST_POOL_ID = '2';
      const reset = testPort(2_600);
      expect(rollout).not.toBe(reset);
    } finally {
      if (saved === undefined) delete process.env.VITEST_POOL_ID;
      else process.env.VITEST_POOL_ID = saved;
    }
  });
});
