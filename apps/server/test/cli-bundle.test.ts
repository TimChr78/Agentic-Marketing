import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestCli, cleanupTestCli } from '../../../test-support/cli';

// #518 review: the bundle used to live in one directory per checkout, so two runs that shared a
// checkout deleted each other's artifact. Each run id must own its directory, and cleanup must
// remove only that one.

const RUN_A = 'bundle-run-a';
const RUN_B = 'bundle-run-b';

describe('bundled CLI artifact', () => {
  afterAll(async () => {
    await cleanupTestCli(RUN_A);
    await cleanupTestCli(RUN_B);
  });

  it('keeps two run ids in separate directories and only removes its own', async () => {
    const a = await buildTestCli(RUN_A);
    const b = await buildTestCli(RUN_B);

    expect(dirname(a)).not.toBe(dirname(b));
    expect(dirname(a)).toContain(RUN_A);
    expect(dirname(b)).toContain(RUN_B);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);

    await cleanupTestCli(RUN_A);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
  }, 120_000);
});
