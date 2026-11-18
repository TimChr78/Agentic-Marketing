import { describe, expect, it } from 'vitest';
import { CancelledError, isAbortError, sleep } from '../src';

// #1028 follow-up: every scheduler and worker loop sleeps between rounds. A sleep that only listens
// for a *later* abort hangs for a whole tick when the signal aborts first — an hour for retention,
// six for the spend import — and SIGTERM waits for it. The helper resolves either way.

describe('cancellation', () => {
  it('recognises our cancellation, a fetch AbortError and Node ABORT_ERR', () => {
    expect(isAbortError(new CancelledError())).toBe(true);
    expect(isAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).toBe(true);
    expect(isAbortError(new Error('the provider refused'))).toBe(false);
    expect(isAbortError({ name: 'AbortError' })).toBe(false);
    expect(isAbortError('aborted')).toBe(false);
  });
});

describe('sleep(ms, signal)', () => {
  it('waits out the interval when nothing aborts', async () => {
    const started = Date.now();
    await sleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('resolves at once when the signal aborted before it was called', async () => {
    const started = Date.now();
    const stop = new AbortController();
    stop.abort();
    await sleep(3_600_000, stop.signal);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('resolves as soon as the signal aborts, not when the interval ends', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const sleeping = sleep(3_600_000, stop.signal);
    setTimeout(() => stop.abort(), 20);
    await expect(sleeping).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('leaves no abort listener behind when it wakes on its own', async () => {
    const stop = new AbortController();
    let listeners = 0;
    const add = stop.signal.addEventListener.bind(stop.signal);
    const remove = stop.signal.removeEventListener.bind(stop.signal);
    stop.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners += 1;
      add(...args);
    }) as typeof add;
    stop.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listeners -= 1;
      remove(...args);
    }) as typeof remove;
    await sleep(5, stop.signal);
    expect(listeners).toBe(0);
  });
});
