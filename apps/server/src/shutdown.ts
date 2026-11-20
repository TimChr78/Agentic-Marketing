import type { RequestAborts } from './http/request-aborts';

// Ordered shutdown for the server process (#1014).
//
// Every close step runs even when an earlier one rejects: a pool that cannot close must not keep
// the listener or the workers alive. A failure is logged with the step's name only: an error's
// message and stack can carry connection strings or personal data, so neither is logged. It makes the process exit non-zero, so a supervisor can tell a clean stop from
// one that left something behind. A second signal does not start a second shutdown; it exits
// immediately, which is what an operator pressing Ctrl-C twice expects.

/**
 * The listener surface the drain needs. A Node `http.Server` and the http2 servers `serve()` may
 * return both offer it; the two close helpers arrived in Node 18.2 and are optional for an older
 * runtime.
 */
export interface HttpListener {
  close: (callback: () => void) => unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

/**
 * How long the http step waits for in-flight requests before it force-closes them (#1059). Must
 * stay well inside the 45 s the deploy files allow the process to stop, leaving room for the
 * worker drain and the pool closes that follow.
 */
export const HTTP_DRAIN_TIMEOUT_MS = 20_000;

/**
 * How long the http step waits, after the force-close, for the aborted handlers to run their own
 * cleanup (#1098). A copilot turn writes its turn and settles its AI reservation here, so the
 * pools that follow close after that write instead of underneath it. It is short: a handler that
 * is still waiting on a provider finishes nothing new, and its store is skipped with a log line.
 */
export const HTTP_INFLIGHT_SETTLE_MS = 5_000;

export interface HttpDrainOptions {
  /** The requests to abort when the bound is hit; omitted by a caller that has no registry. */
  aborts?: RequestAborts;
  /** Overrides {@link HTTP_INFLIGHT_SETTLE_MS}; tests use a small value. */
  settleMs?: number;
}

export interface ShutdownStep {
  /** A short, stable name for the log line; never includes workspace or connection data. */
  name: string;
  close: () => void | Promise<void>;
}

/**
 * Stops one listener and waits, bounded, for the requests already in flight (#1059).
 *
 * `server.close()` stops accepting new connections but reports nothing until every connection has
 * ended. Idle keep-alive sockets are closed at once (Node does this inside `close()` since v19;
 * the explicit call keeps the intent readable and covers an older runtime), so only requests that
 * are actually being answered hold the step. If one is still running at `timeoutMs`, the listener
 * aborts it through `aborts` (so a handler that outlived its client stops starting new work) and
 * force-closes what is left, then waits for those handlers' own cleanup before resolving (#1098).
 */
export async function drainHttpServer(server: HttpListener, timeoutMs: number, opts: HttpDrainOptions = {}): Promise<void> {
  let closed = false;
  const whenClosed = new Promise<void>((resolve) => {
    server.close(() => {
      closed = true;
      resolve();
    });
  });
  server.closeIdleConnections?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      opts.aborts?.abortAll();
      server.closeAllConnections?.();
      resolve();
    }, timeoutMs);
  });
  await Promise.race([whenClosed, bound]);
  // A force-close destroys every connection, so the close callback follows promptly. Waiting for
  // it keeps the promise's meaning: the listener is down when this resolves.
  if (!closed) await whenClosed;
  clearTimeout(timer);
  // The sockets are down, but a handler the abort just woke still has its own cleanup to run. The
  // pools and clients that follow must close after that write, not across it.
  await opts.aborts?.settle(opts.settleMs ?? HTTP_INFLIGHT_SETTLE_MS);
}

/** Drains every listener in parallel; the whole step stays within one `timeoutMs`. */
export async function drainHttpServers(servers: readonly HttpListener[], timeoutMs: number, opts: HttpDrainOptions = {}): Promise<void> {
  await Promise.all(servers.map((server) => drainHttpServer(server, timeoutMs, opts)));
}

export interface ShutdownLog {
  info: (message: string) => void;
  error: (fields: { step: string }, message: string) => void;
}

export interface ShutdownOptions {
  steps: ShutdownStep[];
  log: ShutdownLog;
  exit: (code: number) => void;
}

export interface ShutdownController {
  /** Starts the shutdown once. A later signal forces an immediate, non-zero exit. */
  onSignal: () => void;
  /** Whether a shutdown has started. */
  started: () => boolean;
  /** Resolves after the exit call (or after a forced exit; tests use a fake `exit`). */
  done: () => Promise<void>;
}

/**
 * Runs every step in order. Rejections are logged and remembered; the remaining steps still run.
 * Returns the process exit code: 0 when every step closed, 1 when any step failed.
 */
export async function runShutdownSteps(steps: ShutdownStep[], log: ShutdownLog): Promise<number> {
  let failed = false;
  for (const step of steps) {
    try {
      await step.close();
    } catch {
      failed = true;
      log.error({ step: step.name }, 'shutdown step failed');
    }
  }
  return failed ? 1 : 0;
}

/**
 * Waits for every worker loop to settle, then rejects if any of them rejected, so a worker that
 * failed while draining makes the shutdown exit non-zero instead of being discarded.
 */
export async function drainWorkers(workers: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(workers);
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed) throw new Error(`${failed} worker(s) failed while draining`);
}

/** The signal handler for SIGTERM/SIGINT, with a re-entry guard and a forced exit on the second signal. */
export function createShutdown({ steps, log, exit }: ShutdownOptions): ShutdownController {
  let started = false;
  let forced = false;
  let finished: Promise<void> = Promise.resolve();
  const onSignal = () => {
    if (started) {
      forced = true;
      log.info('second shutdown signal; exiting without waiting for the remaining steps');
      exit(1);
      return;
    }
    started = true;
    log.info('shutting down');
    finished = runShutdownSteps(steps, log).then((code) => {
      // A forced exit already reported the failure; do not report a late success after it.
      if (!forced) exit(code);
    });
  };
  return { onSignal, started: () => started, done: () => finished };
}
