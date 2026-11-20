import type { Context } from 'hono';

// Per-request abort signals for shutdown (#1098).
//
// The http drain waits, bounded, for the requests already being answered (#1059). A request that
// outlives the bound is force-closed, but its handler keeps running: a copilot turn whose provider
// call is slower than the bound would still write its turn, and later shutdown steps would close
// the pools underneath it. The middleware registers every request, so the drain can abort what it
// is about to force-close; a streaming handler then stops starting new steps and finishes its own
// cleanup before the pools close.
//
// #1043 is the rule this follows: a stop prevents new work, it never cuts work already sent. A
// provider call that is on the wire finishes within its own deadline; only the next step is
// refused.

/** The context variable the middleware stores a request's lease under. */
const REQUEST_ABORT = 'requestAbort';

/** One request's hold on its abort controller; a turn that outlives its handler keeps one. */
export interface RequestAbort {
  readonly signal: AbortSignal;
  /** Drops this hold; the request leaves the in-flight set when its last hold drops. */
  release: () => void;
  /**
   * Adds a hold for work that streams after the handler returned, and returns the lease to
   * release it. The middleware's own hold ends with the handler, so a turn takes one of these.
   */
  retain: () => RequestAbort;
}

export interface RequestAborts {
  /** Registers one request; the middleware releases its hold when the handler returns. */
  begin: () => RequestAbort;
  /** Aborts every request still in flight; called when the drain gives up on the sockets. */
  abortAll: () => void;
  /** How many requests are still in flight. */
  count: () => number;
  /**
   * Resolves once no request is in flight; false when `ms` passed first. Never rejects, so a
   * handler that ignores its signal delays the drain by the bound and no more.
   */
  settle: (ms: number) => Promise<boolean>;
}

interface Entry {
  controller: AbortController;
  holds: number;
}

export function createRequestAborts(): RequestAborts {
  const active = new Set<Entry>();
  const waiters = new Set<() => void>();
  const release = (entry: Entry) => {
    entry.holds -= 1;
    if (entry.holds > 0) return;
    active.delete(entry);
    if (active.size) return;
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const leaseOf = (entry: Entry): RequestAbort => {
    let released = false;
    return {
      signal: entry.controller.signal,
      release: () => {
        if (released) return;
        released = true;
        release(entry);
      },
      retain: () => {
        entry.holds += 1;
        return leaseOf(entry);
      },
    };
  };
  return {
    begin() {
      const entry = { controller: new AbortController(), holds: 1 };
      active.add(entry);
      return leaseOf(entry);
    },
    abortAll() {
      for (const entry of active) entry.controller.abort();
    },
    count() {
      return active.size;
    },
    async settle(ms) {
      if (!active.size) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      return new Promise<boolean>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(true);
        };
        timer = setTimeout(() => {
          waiters.delete(done);
          resolve(false);
        }, ms);
        waiters.add(done);
      });
    },
  };
}

/**
 * The middleware that makes a request abortable: every request is registered before its handler
 * runs and released when it returns. The lease travels in the Hono context rather than being
 * keyed by the Request object, because a body guard replaces `c.req.raw` with an equivalent
 * Request after reading the body.
 */
export function withRequestAborts(aborts: RequestAborts) {
  return async (c: Context, next: () => Promise<void>): Promise<void> => {
    const request = aborts.begin();
    (c as unknown as Context<{ Variables: Record<string, unknown> }>).set(REQUEST_ABORT, request);
    try {
      await next();
    } finally {
      request.release();
    }
  };
}

/**
 * A request's lease, for a handler that starts work which may outlive it. Undefined when the
 * routes are mounted without the middleware, e.g. a test with only the copilot app.
 */
export function requestAbortOf(c: Context): RequestAbort | undefined {
  return (c as unknown as Context<{ Variables: Record<string, unknown> }>).get(REQUEST_ABORT) as RequestAbort | undefined;
}
