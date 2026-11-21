import type { Db } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { runOAuthSelectionCleanup } from '../src/workers';

// #1160: shutdown must not close the pool under an in-flight cleanup query, and an already-aborted
// signal must not start one. The slow sweep is gated explicitly, never by a wall-clock bound.

function gatedDb() {
  let calls = 0;
  let started!: () => void;
  const began = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const db = {
    admin: {
      query: async () => {
        calls++;
        started();
        await gate;
        return { rowCount: 0, rows: [] };
      },
    },
  } as unknown as Db;
  return { db, began, release, calls: () => calls };
}

describe('the OAuth selection cleanup worker (#1160)', () => {
  it('does not start a sweep on an already-aborted signal', async () => {
    const { db, calls } = gatedDb();
    const stop = new AbortController();
    stop.abort();
    await runOAuthSelectionCleanup(db, stop.signal, { tickMs: 60_000 });
    expect(calls()).toBe(0);
  });

  it('waits for the in-flight sweep before resolving shutdown', async () => {
    const { db, began, release, calls } = gatedDb();
    const stop = new AbortController();
    const running = runOAuthSelectionCleanup(db, stop.signal, { tickMs: 60_000 });
    await began;

    stop.abort();
    let resolved = false;
    void running.then(() => {
      resolved = true;
    });
    // Give the microtask queue a chance to settle the (not yet finished) promise.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);
    expect(calls()).toBe(1);

    release();
    await running;
    expect(resolved).toBe(true);
    expect(calls()).toBe(1);
  });
});
