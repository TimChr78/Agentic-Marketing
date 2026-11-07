import { createHash } from 'node:crypto';

/**
 * The namespace for one test run, shared by every database, ClickHouse database, NATS namespace
 * and Valkey prefix that run creates. It is lower-case letters and digits only, because the names
 * become unquoted Postgres identifiers.
 *
 * `vitest.config.mts` sets AM_TEST_RUN once for the whole run, so all projects and workers agree.
 * Outside Vitest (the e2e server started with tsx, or a single file run directly) it is derived
 * from the checkout path and this process. CI keeps it empty, so its service containers see the
 * same fixed names and ports as before.
 */
const explicitRun = process.env.AM_TEST_RUN?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';
export const runId =
  explicitRun ||
  (process.env.CI ? '' : `r${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 6)}${process.pid.toString(36)}`);

/** `am_test_p1` becomes `am_<run>_test_p1`; unchanged when there is no run namespace (CI). */
export function runScoped(name: string): string {
  if (!runId) return name;
  return name.startsWith('am_') ? `am_${runId}_${name.slice(3)}` : `am_${runId}_${name}`;
}

/** The port offset from TEST_PORT_OFFSET; 0 when unset or not a number. */
export const testPortOffset = () => Number(process.env.TEST_PORT_OFFSET ?? '0') || 0;
