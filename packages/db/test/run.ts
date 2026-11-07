import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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

/** PostgreSQL truncates identifiers at NAMEDATALEN - 1 bytes; a longer name is a silent bug. */
export const MAX_IDENTIFIER_BYTES = 63;

/** Short enough that `am_<run>_` plus any test database name stays inside the limit. */
export const MAX_RUN_ID_LENGTH = 16;

/**
 * Lower-cases a run id, removes everything that is not a letter or digit, and hashes anything over
 * [MAX_RUN_ID_LENGTH] to 10 hex characters. Hashing keeps two different long ids distinct instead
 * of truncating them to the same prefix.
 */
export function sanitiseRunId(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (clean.length <= MAX_RUN_ID_LENGTH) return clean;
  return createHash('sha256').update(clean).digest('hex').slice(0, 10);
}

const explicitRun = sanitiseRunId(process.env.AM_TEST_RUN ?? '');
export const runId =
  explicitRun ||
  (process.env.CI ? '' : sanitiseRunId(`r${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 6)}${process.pid.toString(36)}`));

/**
 * `am_test_p1` becomes `am_<run>_test_p1`; unchanged when there is no run namespace (CI).
 * Throws when the final name would exceed PostgreSQL's 63-byte identifier limit, because the
 * server would otherwise truncate it and two namespaces could collide.
 */
export function runScopedFor(run: string, name: string): string {
  const scoped = !run ? name : name.startsWith('am_') ? `am_${run}_${name.slice(3)}` : `am_${run}_${name}`;
  const bytes = Buffer.byteLength(scoped, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Scoped identifier is ${bytes} bytes, over PostgreSQL's ${MAX_IDENTIFIER_BYTES}-byte identifier limit: ${scoped}. ` +
        'Shorten the database name or AM_TEST_RUN.',
    );
  }
  return scoped;
}

/**
 * The one authoritative database name for a run: the harness, `test:clean`, the e2e wrapper and
 * the `print-db` CLI all use this. `run` defaults to this process's run namespace.
 */
export function scopedDbName(name: string, run: string = runId): string {
  return runScopedFor(run, name);
}

/** Backwards-compatible alias used throughout the tests. */
export const runScoped = (name: string) => scopedDbName(name);

/** The port offset from TEST_PORT_OFFSET; 0 when unset or not a number. */
export const testPortOffset = (env: Record<string, string | undefined> = process.env) => Number(env.TEST_PORT_OFFSET ?? '0') || 0;

// `node --import tsx packages/db/test/run.ts print-db <name>` prints the exact database name the
// harness creates for AM_TEST_RUN, so a shell wrapper can verify and drop the right database.
// It is inert when this module is imported by the harness, Vitest or a config.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'print-db' || args.length !== 1) {
    console.error('usage: node --import tsx packages/db/test/run.ts print-db <database-name>');
    process.exit(2);
  }
  try {
    console.log(scopedDbName(args[0]));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}
