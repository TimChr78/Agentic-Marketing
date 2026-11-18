/**
 * Waits `ms`, or until `signal` aborts — whichever comes first. Resolves, never rejects: a shutdown
 * is not an error, and every caller is a `while (!signal.aborted)` loop whose next check is the exit.
 *
 * Use this instead of a bare `setTimeout`: a loop that awaits a timer and only then adds an abort
 * listener never wakes when the signal aborted while the round was still running, so it sits out a
 * whole tick (an hour for retention, six for the spend import) while SIGTERM waits (#1028).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
