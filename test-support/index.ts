import { expect } from 'vitest';

// Shared determinism helpers for the Vitest projects (``apps/server/test`` and ``packages/*/test``).
//
// The suite must produce the same result on every machine and worker count:
//   - randomness for fixtures comes from `seededRandom()`, never `Math.random()`;
//   - per-test data uses `uniqueEvent()` / `uniqueJourney()` so one test's person cannot enter
//     another test's journey or holdout;
//   - results whose order is not defined by the query are compared with `expectUnordered()`.

/** The seed used when `AM_TEST_SEED` is absent. Fixed, so a clean checkout is reproducible. */
export const DEFAULT_TEST_SEED = 0x5eed_1234;

let resolvedSeed: number | undefined;
let seedFromEnvironment = false;

/**
 * The seed for this run. `AM_TEST_SEED` overrides the fixed default.
 *
 * On failure the seed is printed once more (and every `uniqueEvent` suffix carries it), so a
 * failing run can be reproduced with `AM_TEST_SEED=<seed>`.
 */
export function testSeed(): number {
  if (resolvedSeed !== undefined) return resolvedSeed;

  const raw = process.env.AM_TEST_SEED;
  if (raw === undefined || raw === '') {
    resolvedSeed = DEFAULT_TEST_SEED;
  } else {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
      throw new Error(`AM_TEST_SEED must be an integer between 0 and 4294967295, received ${JSON.stringify(raw)}`);
    }
    resolvedSeed = parsed >>> 0;
    seedFromEnvironment = true;
  }

  // Vitest reports failures in the main process; a worker can still exit non-zero, and this line
  // also lands in the log before the failure summary. The suffix on unique fixtures is the
  // reliable path, this listener is the convenience.
  process.once('exit', (code) => {
    if (code !== 0 && !seedFromEnvironment) {
      process.stderr.write(`\n[test-support] re-run with AM_TEST_SEED=${resolvedSeed} to reproduce the default seed\n`);
    }
  });

  return resolvedSeed;
}

/** Mulberry32: a small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A deterministic `() => number` in `[0, 1)`, seeded from `AM_TEST_SEED` unless a seed is passed.
 * Create one per file and reuse it, so a test's data does not depend on how many other tests ran.
 */
export function seededRandom(seed: number = testSeed()): () => number {
  return mulberry32(seed);
}

let uniqueCounter = 0;
const eventCache = new Map<string, string>();

/**
 * A short suffix that is unique within the file, stable for a seed and printed with the fixture.
 * It is a counter rather than a timestamp so a rerun with the same seed uses the same names.
 */
export function uniqueSuffix(): string {
  uniqueCounter += 1;
  return `${testSeed().toString(16)}-${uniqueCounter.toString(16)}`;
}

/**
 * A per-test event name, e.g. `Wait Start · 5eed1234-1`. The same base returns the same name
 * within one test, so a journey's trigger and the event the test sends to enter it agree. Use a
 * distinct base (or this helper in each test) for every journey: shared trigger names let one
 * test's person enter another test's journey.
 */
export function uniqueEvent(base: string): string {
  const testName = expect.getState().currentTestName ?? '';
  const key = `${testName}\u0000${base}`;
  const cached = eventCache.get(key);
  if (cached) return cached;
  const value = `${base} · ${uniqueSuffix()}`;
  eventCache.set(key, value);
  return value;
}

export interface JourneyNode {
  kind?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface JourneyContent {
  nodes: JourneyNode[];
  [key: string]: unknown;
}

/**
 * A copy of a journey whose first trigger uses `event` (or a fresh `uniqueEvent('Journey Start')`).
 * Read the chosen name back with `triggerEventOf()` when the test has to send it.
 */
export function uniqueJourney<T extends JourneyContent>(content: T, event: string = uniqueEvent('Journey Start')): T {
  let replaced = false;
  const nodes = content.nodes.map((node) => {
    if (replaced || node.kind !== 'trigger') return node;
    replaced = true;
    return { ...node, config: { ...(node.config ?? {}), event } };
  });
  if (!replaced) throw new Error('uniqueJourney: the journey has no trigger node');
  return { ...content, nodes };
}

/** The event name on a journey's first trigger node. */
export function triggerEventOf(content: JourneyContent): string {
  const trigger = content.nodes.find((node) => node.kind === 'trigger');
  const event = trigger?.config?.event;
  if (typeof event !== 'string') throw new Error('triggerEventOf: the journey has no event trigger');
  return event;
}

/** Stable JSON for messages and deep comparison: object keys are sorted, arrays keep their order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

const deepEqual = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/**
 * Asserts that `actual` contains exactly `expected`, ignoring order. Use it when the query behind a
 * result set has no total order (for example rows written by concurrent journeys in one second);
 * do not add an ordering to product code just to satisfy a test.
 */
export function expectUnordered<T>(actual: readonly T[], expected: readonly T[]): void {
  expect(actual).toHaveLength(expected.length);
  const remaining = [...actual];
  for (const item of expected) {
    const index = remaining.findIndex((candidate) => deepEqual(candidate, item));
    expect(index, `missing ${stableStringify(item)} in ${stableStringify(actual)}`).toBeGreaterThanOrEqual(0);
    remaining.splice(index, 1);
  }
}
