/**
 * A unit of work stopped because its caller is shutting down. This is not a failure of the work:
 * a retry policy must not count it, and nothing about it may be persisted as an error (#1043
 * review). Every cancellation path throws this instead of a provider or driver error.
 */
export class CancelledError extends Error {
  constructor(message = 'the work was cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/**
 * Whether `err` is a cancellation rather than a failure: ours, a `fetch`/DOM `AbortError`, or Node's
 * `ABORT_ERR` (what `node:timers/promises` and `fs` reject with). Callers use it to stop quietly and
 * to keep the failure out of the database.
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err instanceof CancelledError || err.name === 'AbortError' || (err as { code?: unknown }).code === 'ABORT_ERR';
}

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
