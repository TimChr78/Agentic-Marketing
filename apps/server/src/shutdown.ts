// Ordered shutdown for the server process (#1014).
//
// Every close step runs even when an earlier one rejects: a pool that cannot close must not keep
// the listener or the workers alive. A failure is logged with the step's name (never with data
// from the step) and makes the process exit non-zero, so a supervisor can tell a clean stop from
// one that left something behind. A second signal does not start a second shutdown; it exits
// immediately, which is what an operator pressing Ctrl-C twice expects.

export interface ShutdownStep {
  /** A short, stable name for the log line; never includes workspace or connection data. */
  name: string;
  close: () => void | Promise<void>;
}

export interface ShutdownLog {
  info: (message: string) => void;
  error: (fields: { err: unknown; step: string }, message: string) => void;
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
    } catch (err) {
      failed = true;
      log.error({ err, step: step.name }, 'shutdown step failed');
    }
  }
  return failed ? 1 : 0;
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
