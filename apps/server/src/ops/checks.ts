import { lookup as dnsLookup, Resolver } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { isMcpResourceUrlAllowed } from '@agentic-marketing/auth';
import { appRoleReach, createDb, type Db, normalizeHost } from '@agentic-marketing/db';
import { valkeyHotState } from '@agentic-marketing/hotstate';
import { type Config, ENV_KEYS, loadConfig, REQUIRED_ENV_KEYS } from '../config';
import { keyProviderFor } from '../keys';
import { VERSION } from '../version';
import { compareVersions, envKeysSince, INTERNAL_ENV_KEYS, isComposeOrDockerKey, SUPPLIED_BY_COMPOSE } from './env-history';

// Checks for `am doctor`. The offline ones are pure functions over the environment so they can run
// before the stack exists (and are easy to unit-test). The live ones give up after a few seconds:
// a diagnostic must never hang.

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export type Env = Record<string, string | undefined>;

const TIMEOUT_MS = 3000;
const SECONDS = TIMEOUT_MS / 1000;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));

// The host side of the public listener is a Compose setting, not one the container sees. Read the
// default from docker-compose.yml so a changed port in a release does not make this hint stale.
// The image has no compose file; the fallback is the current release default.
const DEFAULT_PUBLIC_BIND = (() => {
  const fallback = '127.0.0.1:3201';
  try {
    const compose = fileURLToPath(new URL('../../../../docker-compose.yml', import.meta.url));
    if (!existsSync(compose)) return fallback;
    return /\$\{PUBLIC_BIND:-([^}]+)\}:/.exec(readFileSync(compose, 'utf8'))?.[1] ?? fallback;
  } catch {
    return fallback;
  }
})();

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Race a promise against the check timeout, so a stuck socket or query cannot block the CLI. */
async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${SECONDS}s`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PLACEHOLDERS = new Set(['change-me', 'change-me-too', 'changeme', 'placeholder', 'secret']);

/** Pending work older than this means nothing is draining the queue (#147). */
const QUEUE_LAG_WARN_SECONDS = 15 * 60;
const BROADCAST_LAG_WARN_SECONDS = 10 * 60;

/** A short human duration for a check message: 45 s, 12 min, 2 h 10 min. */
function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.round(total / 60)} min`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

function isPlaceholder(value: string) {
  return PLACEHOLDERS.has(value.toLowerCase());
}

export function checkAuthSecret(env: Env): Check {
  const id = 'secrets.auth-secret';
  const value = (env.AUTH_SECRET ?? '').trim();
  if (!value) return { id, status: 'fail', message: 'AUTH_SECRET is not set', hint: 'Generate one with `openssl rand -base64 32`.' };
  if (isPlaceholder(value) || value.length < 32)
    return {
      id,
      status: 'fail',
      message: `AUTH_SECRET is ${isPlaceholder(value) ? 'a placeholder' : 'shorter than 32 characters'}`,
      hint: 'Generate one with `openssl rand -base64 32`. Changing it signs everybody out.',
    };
  return { id, status: 'ok', message: `AUTH_SECRET is set (${value.length} characters)` };
}

export function checkMasterKey(env: Env): Check {
  const id = 'secrets.master-key';
  const provider = (env.KEY_PROVIDER ?? '').trim() || 'local';
  if (provider !== 'local') return { id, status: 'ok', message: `MASTER_KEY is not needed with KEY_PROVIDER=${provider}` };

  const value = (env.MASTER_KEY ?? '').trim();
  if (!value) return { id, status: 'fail', message: 'MASTER_KEY is not set', hint: 'Generate one with `openssl rand -base64 32`.' };
  if (isPlaceholder(value))
    return { id, status: 'fail', message: 'MASTER_KEY is still a placeholder', hint: 'Generate one with `openssl rand -base64 32`.' };
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32)
    return {
      id,
      status: 'fail',
      message: `MASTER_KEY decodes to ${bytes.length} bytes instead of 32`,
      hint: 'Generate a 32-byte key with `openssl rand -base64 32`.',
    };
  return { id, status: 'ok', message: 'MASTER_KEY is a 32-byte base64 key' };
}

export function checkPostgresPassword(env: Env): Check {
  const id = 'secrets.postgres-password';
  const value = (env.POSTGRES_PASSWORD ?? '').trim();
  // Compose interpolates this into the database container and into DATABASE_URL. Inside the app
  // container it is normally absent, which is fine.
  if (!value) return { id, status: 'ok', message: 'POSTGRES_PASSWORD is not set here (compose supplies it inside the container)' };
  if (isPlaceholder(value) || value.length < 16)
    return {
      id,
      status: 'fail',
      message: `POSTGRES_PASSWORD is ${isPlaceholder(value) ? 'a placeholder' : 'shorter than 16 characters'}`,
      hint: 'Set a long random password for the Postgres container in the compose .env.',
    };
  return { id, status: 'ok', message: 'POSTGRES_PASSWORD is set and long enough' };
}

export function checkAppDbPassword(env: Env): Check {
  const id = 'secrets.app-db-password';
  const value = (env.APP_DB_PASSWORD ?? '').trim();
  if (!value) return { id, status: 'fail', message: 'APP_DB_PASSWORD is not set', hint: 'Generate one with `openssl rand -hex 24`.' };
  if (isPlaceholder(value) || value.length < 8)
    return {
      id,
      status: 'fail',
      message: `APP_DB_PASSWORD is ${isPlaceholder(value) ? 'a placeholder' : 'shorter than 8 characters'}`,
      hint: 'Generate one with `openssl rand -hex 24`.',
    };
  return { id, status: 'ok', message: 'APP_DB_PASSWORD is set and long enough' };
}

function invalidHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must start with http:// or https://';
    return null;
  } catch {
    return 'is not a valid URL';
  }
}

export function checkPublicUrl(env: Env): Check {
  const id = 'public-url';
  const value = (env.PUBLIC_URL ?? '').trim();
  if (!value)
    return {
      id,
      status: 'ok',
      message: 'PUBLIC_URL is not set; the server uses http://localhost:3000, which only works on this machine',
      hint: 'Set PUBLIC_URL to the address people and AI agents use.',
    };
  const problem = invalidHttpUrl(value);
  if (problem)
    return { id, status: 'fail', message: `PUBLIC_URL ${problem}`, hint: 'Use an absolute URL such as https://marketing.example.com.' };
  if (!isMcpResourceUrlAllowed(value))
    return {
      id,
      status: 'warn',
      message: 'PUBLIC_URL is not HTTPS and not loopback; MCP is off',
      hint: 'Use an HTTPS address (for example through a Cloudflare Tunnel or Tailscale) to enable MCP.',
    };
  return {
    id,
    status: 'ok',
    message: `PUBLIC_URL is ${new URL(value).protocol === 'https:' ? 'HTTPS' : 'loopback HTTP'}`,
  };
}

export function checkPublicLinksUrl(env: Env): Check {
  const id = 'public-links-url';
  const value = (env.PUBLIC_LINKS_URL ?? '').trim();
  if (!value)
    return {
      id,
      status: 'warn',
      message: 'PUBLIC_LINKS_URL is not set; links use PUBLIC_URL',
      hint: 'Set it when a public site proxies link paths, for example https://example.com/am.',
    };
  const problem = invalidHttpUrl(value);
  if (problem)
    return { id, status: 'fail', message: `PUBLIC_LINKS_URL ${problem}`, hint: 'Use an absolute URL such as https://example.com/am.' };

  const publicUrl = (env.PUBLIC_URL ?? '').trim() || 'http://localhost:3000';
  let links: URL;
  let admin: URL;
  try {
    links = new URL(value);
    admin = new URL(publicUrl);
  } catch {
    return {
      id,
      status: 'warn',
      message: 'PUBLIC_LINKS_URL is set, but PUBLIC_URL is invalid so the origins could not be compared',
      hint: 'Fix PUBLIC_URL first.',
    };
  }
  if (links.origin === admin.origin)
    return {
      id,
      status: 'warn',
      message: 'PUBLIC_LINKS_URL has the same origin as PUBLIC_URL; the admin host is the public host',
      hint: 'Use a separate public host for links so the admin UI is not exposed with them.',
    };
  return { id, status: 'ok', message: 'PUBLIC_LINKS_URL is set and uses a different origin from PUBLIC_URL' };
}

export function checkPublicPort(env: Env): Check {
  const id = 'public-port';
  const value = (env.PUBLIC_PORT ?? '').trim();
  const bind = (env.PUBLIC_BIND ?? '').trim() || DEFAULT_PUBLIC_BIND;
  const hint = `docker compose publishes it on the host at ${bind} (PUBLIC_BIND in .env); point the tunnel or proxy there. A tunnel container on a Docker network reaches the app directly, so no host port is needed: remove the mapping with \`ports: !override\` in compose.override.yaml.`;
  if (!value)
    return {
      id,
      status: 'warn',
      message: 'PUBLIC_PORT is not set; the server only listens on the admin port',
      hint: `Set PUBLIC_PORT=3001 to serve the public form, link, click and webhook paths separately. ${hint}`,
    };
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return {
      id,
      status: 'fail',
      message: `PUBLIC_PORT is not a valid port: ${value}`,
      hint: 'Use a number between 1 and 65535, for example 3001.',
    };
  return { id, status: 'ok', message: `PUBLIC_PORT=${port} is set and published on ${bind}`, hint };
}

/** The host-side port of a PUBLIC_BIND value: "127.0.0.1:3201", "0.0.0.0:3000" and "[::1]:3201". */
function hostPort(bind: string): number | undefined {
  const match = /:(\d+)$/.exec(bind.trim());
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Compose always publishes the public listener, even when PUBLIC_PORT is unset, so a host port
 * equal to AM_PORT makes `docker compose up` fail with "address already in use". PUBLIC_BIND and
 * AM_PORT are Compose settings the app container does not see, so `am doctor --env-file` passes
 * them in; this compares the two values instead of probing the host's ports, which a container
 * could not see.
 */
export function checkPorts(env: Env): Check {
  const id = 'ports';
  const bind = (env.PUBLIC_BIND ?? '').trim() || DEFAULT_PUBLIC_BIND;
  const adminRaw = (env.AM_PORT ?? '').trim();
  const admin = adminRaw ? Number(adminRaw) : 3000;
  const publicPort = hostPort(bind);
  const drop = '`ports: !override` in compose.override.yaml';
  if (!Number.isInteger(admin) || admin < 1 || admin > 65535)
    return {
      id,
      status: 'fail',
      message: `AM_PORT is not a valid port: ${adminRaw}`,
      hint: 'Use a number between 1 and 65535, for example 3210.',
    };
  if (publicPort === undefined)
    return {
      id,
      status: 'fail',
      message: `PUBLIC_BIND has no usable port: ${bind}`,
      hint: 'Use host:port, for example 127.0.0.1:3201.',
    };
  if (publicPort === admin)
    return {
      id,
      status: 'fail',
      message: `PUBLIC_BIND publishes the public listener on port ${publicPort}, the same as AM_PORT`,
      hint: `Set PUBLIC_BIND to another port (for example 127.0.0.1:3201), or drop the public mapping with ${drop}. Compose would try to bind ${bind} and ${admin} and fail with "address already in use"; on the host, check with \`ss -ltn | grep ':${publicPort} '\`.`,
    };
  return {
    id,
    status: 'ok',
    message: `PUBLIC_BIND publishes the public listener on ${bind}, which does not collide with AM_PORT=${admin}`,
  };
}

export function checkTrustedProxyCidrs(env: Env): Check {
  const id = 'trusted-proxy-cidrs';
  const value = (env.TRUSTED_PROXY_CIDRS ?? '').trim();
  if (!value)
    return {
      id,
      status: 'warn',
      message: 'TRUSTED_PROXY_CIDRS is empty; forwarding headers are ignored and the socket address is used',
      hint: 'Set it to the proxy and loopback ranges, for example 127.0.0.1/32,::1/128,10.0.0.0/8.',
    };
  return { id, status: 'ok', message: 'forwarded headers are trusted only from the configured proxy ranges' };
}

export function offlineChecks(env: Env): Check[] {
  return [
    checkAuthSecret(env),
    checkMasterKey(env),
    checkPostgresPassword(env),
    checkAppDbPassword(env),
    checkPublicUrl(env),
    checkPublicLinksUrl(env),
    checkPublicPort(env),
    checkPorts(env),
    checkTrustedProxyCidrs(env),
  ];
}

/** Assignment keys in an env file. With `commented`, also picks up `# KEY=` documentation lines. */
export function envFileKeys(text: string, commented = false): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) {
      keys.push(match[1]);
      continue;
    }
    if (!commented) continue;
    const commentedMatch = /^#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (commentedMatch) keys.push(commentedMatch[1]);
  }
  return keys;
}

/** The uncommented values in an env file, for checks that need the value rather than the key. */
export function envFileValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))))
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

/**
 * Compare an env file with the template and with the keys the current server understands.
 * `from` is the release the file comes from; without it the file's AM_VERSION is used. Variables
 * that are only new since a later release are not this install's problem.
 */
export function envFileChecks(fileText: string, exampleText: string, from?: string): Check[] {
  const known = new Set([...envFileKeys(exampleText, true), ...ENV_KEYS]);
  const present = new Set(envFileKeys(fileText));
  // Docker Compose reads COMPOSE_* and DOCKER_* from .env too; they are not app configuration.
  const unknown = [...present].filter((key) => !known.has(key) && !isComposeOrDockerKey(key)).sort();
  const fromVersion = (from ?? envFileValues(fileText).AM_VERSION)?.trim();
  const checks: Check[] = [
    unknown.length
      ? {
          id: 'env-file.unknown',
          status: 'warn',
          message: `unknown or obsolete keys: ${unknown.join(', ')}`,
          hint: 'Remove them or compare with the current .env.example; the server ignores keys it does not know.',
        }
      : { id: 'env-file.unknown', status: 'ok', message: 'no unknown or obsolete keys' },
  ];

  if (!fromVersion) {
    checks.push({
      id: 'env-file.missing',
      status: 'info',
      message: 'AM_VERSION is not set, so variables new since your version cannot be listed',
      hint: 'Set AM_VERSION in .env or pass --from <version>; that is the version you are upgrading from.',
    });
    return checks;
  }
  if (compareVersions(fromVersion, VERSION) === null) {
    checks.push({
      id: 'env-file.missing',
      status: 'info',
      message: `could not compare "${fromVersion}" with the running version ${VERSION}`,
      hint: 'Pass a release version such as 0.2.3 with --from.',
    });
    return checks;
  }

  const newer = (envKeysSince(fromVersion) ?? []).filter(
    (key) => !present.has(key) && !SUPPLIED_BY_COMPOSE.has(key) && !INTERNAL_ENV_KEYS.has(key),
  );
  const required = newer.filter((key) => REQUIRED_ENV_KEYS.includes(key));
  const optional = newer.filter((key) => !REQUIRED_ENV_KEYS.includes(key));
  checks.push(
    newer.length
      ? {
          id: 'env-file.missing',
          status: required.length ? 'warn' : 'info',
          message: `new since ${fromVersion}: ${[
            required.length ? `${required.join(', ')} (required)` : '',
            optional.length ? `${optional.join(', ')} (optional, defaults apply)` : '',
          ]
            .filter(Boolean)
            .join('; ')}`,
          hint: required.length
            ? 'Add the required keys from the current .env.example before starting the new version.'
            : 'Add any you want from the current .env.example; the defaults apply until you do.',
        }
      : {
          id: 'env-file.missing',
          status: 'ok',
          message:
            compareVersions(fromVersion, VERSION) === 0
              ? `no variables added since ${fromVersion} (the running version)`
              : `no variables added after ${fromVersion}`,
        },
  );
  return checks;
}

export function checkConfig(env: Env = process.env): { check: Check; config?: Config } {
  try {
    const config = loadConfig(env);
    return { check: { id: 'config', status: 'ok', message: 'configuration is valid' }, config };
  } catch (err) {
    return {
      check: {
        id: 'config',
        status: 'fail',
        message: messageOf(err).replace(/\s*\n\s*/g, '; '),
        hint: 'Fix the values in .env. Never generate new secrets for an existing install: a new MASTER_KEY cannot read the stored provider secrets, and a new POSTGRES_PASSWORD does not match the database volume.',
      },
    };
  }
}

interface ProviderRow {
  adapter: string;
  from_email: string;
  config: Record<string, unknown> | null;
  /** The workspace's verified primary brand host, when it has one (#188). */
  links_host?: string | null;
}

async function migrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((file) => file.endsWith('.sql')).sort();
}

/**
 * An interrupted `CREATE INDEX CONCURRENTLY` leaves an INVALID index that `IF NOT EXISTS` would
 * skip forever, so the next migration run drops and rebuilds it. Report one that is still here.
 */
async function invalidIndexCheck(db: Db): Promise<Check> {
  const { rows } = await withTimeout(
    db.admin.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT i.indisvalid AND n.nspname = current_schema()
        ORDER BY c.relname`,
    ),
    'invalid indexes',
  );
  if (!rows.length)
    return { id: 'migrations.invalid-indexes', status: 'ok', message: 'no invalid indexes are left from an interrupted build' };
  return {
    id: 'migrations.invalid-indexes',
    status: 'warn',
    message: `${rows.length} invalid index(es) left by an interrupted concurrent build: ${rows.map((row) => row.name).join(', ')}`,
    hint: 'Run `am migrate` (or restart the app): the no-transaction migration drops each invalid index and builds it again.',
  };
}

/**
 * The 0.10.1 `sent_at` backfill runs after the migration, in batches, so a large install never
 * rewrites the message log in one transaction. Until a row is filled, delivery caps count it from
 * `updated_at`, exactly as 0.10.0 did; this line shows how much is left.
 */
async function sentAtBackfillCheck(db: Db): Promise<Check | null> {
  const { rows } = await withTimeout(
    db.admin.query<{ present: boolean }>(
      `SELECT to_regclass('public.messages') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'sent_at'
              ) AS present`,
    ),
    'sent_at column',
  );
  if (!rows[0]?.present) return null;
  const counted = await withTimeout(
    db.admin.query<{ pending: string }>(
      `SELECT count(*)::text AS pending FROM messages
        WHERE sent_at IS NULL AND status IN ('sent', 'delivered', 'bounced', 'complained')`,
    ),
    'sent_at backfill progress',
  );
  const pending = Number(counted.rows[0]?.pending ?? 0);
  return pending
    ? {
        id: 'migrations.sent-at-backfill',
        status: 'info',
        message: `${pending} completed message(s) still age from updated_at; the sent_at backfill is running in batches`,
        hint: 'The scheduler fills up to 10,000 per batch after start and resumes after a restart; delivery caps are correct meanwhile.',
      }
    : { id: 'migrations.sent-at-backfill', status: 'ok', message: 'every completed message has its send time' };
}

async function postgresChecks(db: Db): Promise<{ checks: Check[]; reachable: boolean }> {
  try {
    await withTimeout(db.admin.query('SELECT 1'), 'Postgres');
  } catch (err) {
    return {
      reachable: false,
      checks: [
        {
          id: 'postgres',
          status: 'fail',
          message: `Postgres is unreachable: ${messageOf(err)}`,
          hint: 'Check DATABASE_URL and that the Postgres container is running.',
        },
      ],
    };
  }

  const checks: Check[] = [{ id: 'postgres', status: 'ok', message: 'Postgres is reachable' }];
  try {
    const [files, applied] = await Promise.all([
      migrationFiles(),
      withTimeout(db.admin.query<{ version: string }>('SELECT version FROM schema_migrations'), 'schema_migrations'),
    ]);
    const done = new Set(applied.rows.map((row) => row.version));
    const pending = files.filter((file) => !done.has(file));
    checks.push(
      pending.length
        ? {
            id: 'migrations',
            status: 'warn',
            message: `${pending.length} pending migration(s), starting with ${pending[0]}; start the app to migrate`,
            hint: 'Run `docker compose up -d` (or `am migrate`) and run `am doctor` again.',
          }
        : { id: 'migrations', status: 'ok', message: 'database schema is up to date' },
    );
  } catch (err) {
    const missing = (err as { code?: string }).code === '42P01';
    checks.push({
      id: 'migrations',
      status: 'warn',
      message: missing
        ? 'schema_migrations is missing; start the app to migrate'
        : `could not read the migration state: ${messageOf(err)}; start the app to migrate`,
      hint: 'Run `docker compose up -d` (or `am migrate`) and run `am doctor` again.',
    });
  }
  try {
    checks.push(await invalidIndexCheck(db));
  } catch (err) {
    checks.push({
      id: 'migrations.invalid-indexes',
      status: 'warn',
      message: `could not check for invalid indexes: ${messageOf(err)}`,
    });
  }
  try {
    const backfill = await sentAtBackfillCheck(db);
    if (backfill) checks.push(backfill);
  } catch (err) {
    checks.push({
      id: 'migrations.sent-at-backfill',
      status: 'info',
      message: `could not read the sent_at backfill progress: ${messageOf(err)}`,
    });
  }
  return { checks, reachable: true };
}

/**
 * Proves the configured key provider can unseal a data key in the live database (#143). The
 * format check in `checkMasterKey` cannot see a key that was rotated or replaced.
 */
export async function checkDataKeyProvider(config: Config, db: Db): Promise<Check> {
  const id = 'secrets.master-key-live';
  try {
    const { rows } = await withTimeout(
      db.admin.query<{ id: string; kek_id: string; wrapped_key: Buffer }>(
        'SELECT id, kek_id, wrapped_key FROM data_keys ORDER BY created_at, id LIMIT 1',
      ),
      'reading a data key',
    );
    if (!rows.length) return { id, status: 'info', message: 'no data keys yet; the key is checked when the first secret is stored' };
    const provider = keyProviderFor(config);
    const key = await withTimeout(provider.unwrap(rows[0].wrapped_key, rows[0].kek_id), 'unwrapping a data key');
    if (key.length !== 32)
      return {
        id,
        status: 'fail',
        message: `unwrapped data key ${rows[0].id} is ${key.length} bytes instead of 32`,
        hint: 'The stored key is corrupt or was wrapped by something other than this key provider.',
      };
    return { id, status: 'ok', message: `${provider.id} unwraps the workspace data keys` };
  } catch (err) {
    if ((err as { code?: string }).code === '42P01')
      return {
        id,
        status: 'warn',
        message: 'data_keys is missing; start the app to migrate',
        hint: 'Run `docker compose up -d` (or `am migrate`) and run `am doctor` again.',
      };
    return {
      id,
      status: 'fail',
      message: `the configured key provider cannot unwrap a stored data key: ${messageOf(err)}`,
      hint:
        'Set MASTER_KEY to the key the workspace was created with, or add the old key to MASTER_KEY_PREVIOUS ' +
        'and run `am rotate-keys`. A restore needs the same key; see docs/deployment/backups.md.',
    };
  }
}

/**
 * The app role must not bypass row-level security (#813). A role created with SUPERUSER or
 * BYPASSRLS (by hand, by an old install or by another tool) makes every request skip tenant
 * isolation, and so does any role it can `SET ROLE` into — directly or through a chain, since
 * `NOINHERIT` does not stop `SET ROLE` (0.14.11 round 4). `am migrate` resets the role's own
 * attributes and refuses a privileged membership; only a superuser can change either, so when the
 * migration user cannot, this check names the role, the chain and the fix instead of letting the
 * bypass go unnoticed.
 */
export async function checkAppRole(config: Config, db: Db): Promise<Check> {
  const id = 'postgres.app-role';
  const role = config.appDbRole;
  try {
    const reach = await withTimeout(appRoleReach(db.admin, role), 'the app role');
    const self = reach.find((r) => r.role === role);
    if (!self) return { id, status: 'info', message: `the app role ${role} does not exist yet; starting the app creates it` };
    const words = (r: { superuser: boolean; bypassrls: boolean }) =>
      [r.superuser ? 'SUPERUSER' : '', r.bypassrls ? 'BYPASSRLS' : ''].filter(Boolean).join(' and ');
    const own = words(self);
    const reached = reach.filter((r) => r.role !== role && (r.superuser || r.bypassrls));
    if (!own && !reached.length) return { id, status: 'ok', message: `the app role ${role} cannot bypass row-level security` };
    const parts = [
      own ? `has ${own}` : '',
      reached.length ? `can SET ROLE to ${reached.map((r) => `“${r.role}” (${words(r)}) via ${r.chain.join(' → ')}`).join('; ')}` : '',
    ].filter(Boolean);
    const revoke = reached.map((r) => ` and "REVOKE ${r.role} FROM ${role}"`).join('');
    return {
      id,
      status: 'fail',
      message: `the app role ${role} ${parts.join(', and ')}, so row-level security is bypassed for every request`,
      hint: `As a superuser run "ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS"${revoke}, or set APP_DB_ROLE to a dedicated unprivileged role, then run \`am migrate\` again.`,
    };
  } catch (err) {
    return { id, status: 'warn', message: `could not read the app role’s attributes: ${messageOf(err)}` };
  }
}

export async function checkClickHouse(config: Config): Promise<Check> {
  const url = `${config.clickhouse.url.replace(/\/+$/, '')}/ping`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok)
      return {
        id: 'clickhouse',
        status: 'fail',
        message: `ClickHouse /ping returned HTTP ${res.status}`,
        hint: 'Check CLICKHOUSE_URL and the ClickHouse container.',
      };
    return { id: 'clickhouse', status: 'ok', message: 'ClickHouse is reachable' };
  } catch (err) {
    return {
      id: 'clickhouse',
      status: 'fail',
      message: `ClickHouse is unreachable: ${messageOf(err)}`,
      hint: 'Check CLICKHOUSE_URL and that the ClickHouse container is running.',
    };
  }
}

function probeTcp(host: string, port: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(TIMEOUT_MS, () => done(new Error(`${what} timed out after ${SECONDS}s`)));
    socket.once('connect', () => done());
    socket.once('error', (err) => done(err));
  });
}

export async function checkNats(config: Config): Promise<Check> {
  let url: URL;
  try {
    url = new URL(config.nats.url);
  } catch {
    return { id: 'nats', status: 'fail', message: 'NATS_URL is not a valid URL', hint: 'Use a URL such as nats://localhost:4222.' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 4222);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    return {
      id: 'nats',
      status: 'fail',
      message: 'NATS_URL has no usable host and port',
      hint: 'Use a URL such as nats://localhost:4222.',
    };
  try {
    await probeTcp(host, port, 'NATS');
    return { id: 'nats', status: 'ok', message: `NATS is reachable at ${host}:${port}` };
  } catch (err) {
    return {
      id: 'nats',
      status: 'fail',
      message: `NATS is unreachable at ${host}:${port}: ${messageOf(err)}`,
      hint: 'Check NATS_URL and that the NATS container is running.',
    };
  }
}

export async function checkValkey(config: Config): Promise<Check> {
  const hot = valkeyHotState({ url: config.valkey.url, prefix: config.valkey.prefix });
  try {
    const pong = await withTimeout(hot.ping(), 'Valkey PING');
    return pong
      ? { id: 'valkey', status: 'ok', message: 'Valkey answered PING' }
      : {
          id: 'valkey',
          status: 'fail',
          message: 'Valkey did not answer PING',
          hint: 'Check VALKEY_URL, the password in it, and that the Valkey container is running.',
        };
  } catch (err) {
    return {
      id: 'valkey',
      status: 'fail',
      message: `Valkey is unreachable: ${messageOf(err)}`,
      hint: 'Check VALKEY_URL and that the Valkey container is running.',
    };
  } finally {
    await hot.close().catch(() => {});
  }
}

/**
 * Operational health the platform can answer from its own tables (#147): how far each queue is
 * behind and whether webhook/action deliveries are dead-lettering. Cheap aggregate queries, no
 * workspace or personal data, and every one gives up after the usual check timeout.
 */
export async function operationalHealthChecks(db: Db): Promise<Check[]> {
  let row:
    | {
        messages_pending: string;
        messages_oldest_seconds: string;
        journey_due: string;
        journey_oldest_due_seconds: string;
        broadcast_due: string;
        broadcast_oldest_seconds: string;
        warehouse_due: string;
        deliveries_dead_24h: string;
        deliveries_dead_hour: string;
        deliveries_finished_hour: string;
      }
    | undefined;
  try {
    const result = await withTimeout(
      db.admin.query<NonNullable<typeof row>>(
        `SELECT
           (SELECT count(*) FROM messages WHERE status IN ('queued', 'sending')) AS messages_pending,
           (SELECT COALESCE(max(EXTRACT(EPOCH FROM now() - created_at)), 0) FROM messages
              WHERE status IN ('queued', 'sending')) AS messages_oldest_seconds,
           (SELECT count(*) FROM journey_participants
              WHERE status IN ('ready', 'waiting') AND due_at <= now()) AS journey_due,
           (SELECT COALESCE(max(EXTRACT(EPOCH FROM now() - due_at)), 0) FROM journey_participants
              WHERE status IN ('ready', 'waiting') AND due_at <= now()) AS journey_oldest_due_seconds,
           (SELECT count(*) FROM broadcast_runs
              WHERE send_at <= now()
                AND (status = 'scheduled' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now())))) AS broadcast_due,
           (SELECT COALESCE(max(EXTRACT(EPOCH FROM now() - send_at)), 0) FROM broadcast_runs
              WHERE send_at <= now()
                AND (status = 'scheduled' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now())))) AS broadcast_oldest_seconds,
           (SELECT count(*) FROM warehouse_exports
              WHERE enabled AND (run_requested OR last_run_at IS NULL OR last_run_at < now() - every_minutes * interval '1 minute'))
             AS warehouse_due,
           (SELECT count(*) FROM deliveries
              WHERE status = 'dead' AND finished_at > now() - interval '24 hours') AS deliveries_dead_24h,
           (SELECT count(*) FROM deliveries
              WHERE status = 'dead' AND finished_at > now() - interval '1 hour') AS deliveries_dead_hour,
           (SELECT count(*) FROM deliveries WHERE finished_at > now() - interval '1 hour') AS deliveries_finished_hour`,
      ),
      'queue health',
    );
    row = result.rows[0];
  } catch (err) {
    // A fresh install has no tables yet; that is not an operational failure.
    if ((err as { code?: string }).code === '42P01')
      return [{ id: 'queues', status: 'info', message: 'queue and delivery checks skipped until the schema is migrated' }];
    return [
      {
        id: 'queues',
        status: 'warn',
        message: `queue and delivery checks could not run: ${messageOf(err)}`,
        hint: 'Check the database user and schema, then run `am doctor` again.',
      },
    ];
  }
  if (!row) return [];

  const checks: Check[] = [];
  const pending = Number(row.messages_pending);
  const messagesOldest = Number(row.messages_oldest_seconds);
  checks.push(
    pending === 0
      ? { id: 'queue.messages', status: 'ok', message: 'no messages are waiting to be sent' }
      : messagesOldest > QUEUE_LAG_WARN_SECONDS
        ? {
            id: 'queue.messages',
            status: 'warn',
            message: `${pending} message(s) waiting to be sent; the oldest has waited ${duration(messagesOldest)}`,
            hint: 'A queue that does not drain means the worker role is not running or is stuck: check ROLE=worker and `docker compose logs worker` (or the worker pods).',
          }
        : {
            id: 'queue.messages',
            status: 'ok',
            message: `${pending} message(s) waiting to be sent; the oldest has waited ${duration(messagesOldest)}`,
          },
  );

  const journeyDue = Number(row.journey_due);
  const journeyOldest = Number(row.journey_oldest_due_seconds);
  checks.push(
    journeyDue === 0
      ? { id: 'queue.journeys', status: 'ok', message: 'no journey step is due' }
      : journeyOldest > QUEUE_LAG_WARN_SECONDS
        ? {
            id: 'queue.journeys',
            status: 'warn',
            message: `${journeyDue} journey step(s) due; the oldest has waited ${duration(journeyOldest)}`,
            hint: 'Journey steps run in the worker role: check that ROLE includes worker and that `docker compose logs worker` shows the journey sweeper running.',
          }
        : {
            id: 'queue.journeys',
            status: 'ok',
            message: `${journeyDue} journey step(s) due; the oldest has waited ${duration(journeyOldest)}`,
          },
  );

  const broadcastDue = Number(row.broadcast_due);
  const broadcastOldest = Number(row.broadcast_oldest_seconds);
  checks.push(
    broadcastDue === 0
      ? { id: 'queue.broadcasts', status: 'ok', message: 'no broadcast is waiting to be sent' }
      : broadcastOldest > BROADCAST_LAG_WARN_SECONDS
        ? {
            id: 'queue.broadcasts',
            status: 'warn',
            message: `${broadcastDue} broadcast run(s) past their send time; the oldest by ${duration(broadcastOldest)}`,
            hint: 'Broadcasts run in the scheduler role (keep it at one replica): check that ROLE includes scheduler and its logs.',
          }
        : { id: 'queue.broadcasts', status: 'ok', message: `${broadcastDue} broadcast run(s) being sent` },
  );

  const warehouseDue = Number(row.warehouse_due);
  checks.push({
    id: 'queue.warehouse',
    status: 'ok',
    message: warehouseDue ? `${warehouseDue} warehouse export(s) due or requested` : 'no warehouse export is due',
  });

  const dead24h = Number(row.deliveries_dead_24h);
  const deadHour = Number(row.deliveries_dead_hour);
  const finishedHour = Number(row.deliveries_finished_hour);
  checks.push(
    dead24h === 0
      ? { id: 'deliveries', status: 'ok', message: 'no webhook or action delivery ended dead in the last 24 hours' }
      : {
          id: 'deliveries',
          status: 'warn',
          message: `${dead24h} webhook/action delivery(ies) ended dead in the last 24 hours (${deadHour} of ${finishedHour} finished in the last hour)`,
          hint: 'A dead delivery stopped after its retries: check the endpoint URL, its response and the egress allow list (EGRESS_ALLOWED_HOSTS).',
        },
  );
  return checks;
}

export interface BrandDomainRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  host: string;
  pathPrefix: string | null;
  isPrimary: boolean;
  status: string;
}

export interface BrandDomainDeps {
  lookup?: (host: string) => Promise<unknown>;
  probe?: (url: string) => Promise<number>;
  /** Extra reserved hosts to quarantine, on top of PUBLIC_URL and PUBLIC_LINKS_URL. */
  reservedHosts?: string[];
}

/** Reads the registry for `am doctor`; a fresh install has no table yet, which means no domains. */
async function readBrandDomains(db: Db): Promise<{ domains: BrandDomainRow[]; workspaces: { id: string; name: string }[] } | null> {
  try {
    const [domainResult, workspaceResult] = await Promise.all([
      withTimeout(
        db.admin.query<BrandDomainRow>(
          `SELECT d.id, d.workspace_id AS "workspaceId", w.name AS "workspaceName", d.host,
                  d.path_prefix AS "pathPrefix", d.is_primary AS "isPrimary", d.status
             FROM workspace_domains d
             JOIN workspaces w ON w.id = d.workspace_id
            ORDER BY d.host, d.path_prefix`,
        ),
        'brand domains',
      ),
      withTimeout(db.admin.query<{ id: string; name: string }>('SELECT id, name FROM workspaces ORDER BY created_at'), 'workspaces'),
    ]);
    return { domains: domainResult.rows, workspaces: workspaceResult.rows };
  } catch (err) {
    // A fresh install has no tables yet; that means "no domains", not a failure.
    if ((err as { code?: string }).code === '42P01') return { domains: [], workspaces: [] };
    return null;
  }
}

const NON_PUBLIC_TLDS = new Set(['localhost', 'internal', 'invalid', 'test', 'example']);

function brandOrigin(host: string): string {
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${local ? 'http' : 'https'}://${authority}`;
}

function looksLikeTlsError(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  if (code && /CERT|TLS|SSL/.test(code)) return true;
  return /certificate|tls|ssl/i.test(messageOf(err));
}

/**
 * Per registered brand domain: DNS resolves, the public listener answers `/healthz` (under any
 * path prefix) and the certificate is valid. Also warns when a multi-workspace install has brands
 * without a primary domain, because their links fall back to PUBLIC_LINKS_URL.
 */
export async function checkBrandDomains(
  domains: BrandDomainRow[],
  workspaces: { id: string; name: string }[],
  config: Pick<Config, 'publicUrl' | 'linksUrl'>,
  deps: BrandDomainDeps = {},
): Promise<Check[]> {
  const lookup = deps.lookup ?? ((host: string) => dnsLookup(host));
  const probe = deps.probe ?? probeHttp;
  const adminHost = new URL(config.publicUrl).hostname.toLowerCase();
  // The admin and fallback hosts belong to the installation, so the resolver quarantines any row
  // on them. A 0.10.0 install could still have verified one; report it so an operator can remove it.
  const reservedHosts = new Set(deps.reservedHosts ?? []);
  for (const value of [config.publicUrl, config.linksUrl]) {
    try {
      reservedHosts.add(normalizeHost(new URL(value).hostname));
    } catch {
      // A malformed configured URL is reported by config checks; skip it here.
    }
  }
  const checks: Check[] = [];

  checks.push(
    ...(await Promise.all(
      domains.map(async (domain) => {
        const id = `brand-domains.${domain.host}${domain.pathPrefix ?? ''}`;
        const label = `${domain.host}${domain.pathPrefix ?? ''}`;
        if (reservedHosts.has(domain.host))
          return {
            id,
            status: 'warn' as const,
            message: `${label} is a reserved installation host (the admin or fallback links host) and is ignored by the resolver`,
            hint: `Remove the row with workspace.domains.remove {id: "${domain.id}"} in that brand (or DELETE FROM workspace_domains WHERE id = '${domain.id}'), then map the brand to its own hostname.`,
          };
        if (domain.status !== 'verified')
          return {
            id,
            status: 'warn' as const,
            message: `${label} is pending verification; links and public pages do not use it yet`,
            hint: 'Run workspace.domains.verify once the hostname reaches this installation (the challenge is served at /.well-known/am-domain/<token>).',
          };
        if (domain.host === adminHost)
          return {
            id,
            status: 'warn' as const,
            message: `${label} is the admin host; brand links will share the admin hostname`,
            hint: 'Register the brand’s own hostname, and keep the admin host separate unless sharing is intended.',
          };

        try {
          await withTimeout(Promise.resolve(lookup(domain.host)), `DNS lookup for ${domain.host}`);
        } catch (err) {
          return {
            id,
            status: 'fail' as const,
            message: `${domain.host} does not resolve: ${messageOf(err)}`,
            hint: 'Create the DNS record for the brand hostname (a CNAME to the tunnel, or the A/AAAA record of this host).',
          };
        }

        const url = `${brandOrigin(domain.host)}${domain.pathPrefix ?? ''}/healthz`;
        try {
          const status = await probe(url);
          if (status >= 200 && status < 400) return { id, status: 'ok' as const, message: `${label} answers ${url} (HTTP ${status})` };
          if (status === 404)
            return {
              id,
              status: 'warn' as const,
              message: `${label} does not answer ${url} (HTTP 404)`,
              hint: 'Point the tunnel or proxy at the public listener and check the path prefix.',
            };
          return {
            id,
            status: 'fail' as const,
            message: `${label} answered ${url} with HTTP ${status}`,
            hint: 'Check the tunnel rule and that the public listener is running.',
          };
        } catch (err) {
          if (looksLikeTlsError(err))
            return {
              id,
              status: 'fail' as const,
              message: `${label} has an invalid TLS certificate: ${messageOf(err)}`,
              hint: 'Issue a certificate that covers this hostname (the tunnel’s certificate or a matching wildcard).',
            };
          return {
            id,
            status: 'fail' as const,
            message: `${label} does not answer ${url}: ${messageOf(err)}`,
            hint: 'Check the tunnel or proxy rule and that the public listener is running.',
          };
        }
      }),
    )),
  );

  if (!domains.length) {
    checks.unshift({
      id: 'brand-domains',
      status: workspaces.length > 1 ? 'warn' : 'ok',
      message:
        workspaces.length > 1
          ? `${workspaces.length} workspaces have no brand domain; every link uses PUBLIC_LINKS_URL`
          : 'no brand domains registered; links use PUBLIC_LINKS_URL',
      ...(workspaces.length > 1
        ? { hint: 'Add a primary domain per brand with workspace.domains.add, or accept one shared links host.' }
        : {}),
    });
  }

  if (workspaces.length > 1) {
    const withPrimary = new Set(
      domains.filter((domain) => domain.isPrimary && domain.status === 'verified').map((domain) => domain.workspaceId),
    );
    const missing = workspaces.filter((workspace) => !withPrimary.has(workspace.id));
    if (missing.length)
      checks.push({
        id: 'brand-domains.primary',
        status: 'warn',
        message: `${missing.length} of ${workspaces.length} workspaces have no primary brand domain (${missing
          .map((workspace) => workspace.name)
          .join(', ')}); their links use PUBLIC_LINKS_URL`,
        hint: 'Register a primary domain for each brand with workspace.domains.add and isPrimary true.',
      });
  }

  // A registered host on a reserved/non-public suffix cannot get a public certificate.
  const reserved = domains.filter((domain) => NON_PUBLIC_TLDS.has(domain.host.split('.').pop() ?? ''));
  if (reserved.length)
    checks.push({
      id: 'brand-domains.public',
      status: 'warn',
      message: `${reserved.map((domain) => domain.host).join(', ')} use a reserved or private suffix`,
      hint: 'Use a public hostname for brand links; localhost and test suffixes work only on this machine.',
    });

  return checks;
}

async function readProviders(db: Db): Promise<ProviderRow[] | null> {
  try {
    const { rows } = await withTimeout(
      db.admin.query<ProviderRow>(
        `SELECT p.adapter, p.from_email, p.config,
                (SELECT d.host FROM workspace_domains d
                  WHERE d.workspace_id = p.workspace_id AND d.is_primary AND d.status = 'verified'
                  ORDER BY d.created_at LIMIT 1) AS links_host
           FROM email_providers p
          WHERE p.enabled = true`,
      ),
      'email providers',
    );
    return rows;
  } catch (err) {
    // A fresh install has no tables yet; that means "no providers", not a failure.
    if ((err as { code?: string }).code === '42P01') return [];
    return null;
  }
}

/** TXT lookup, injectable so tests do not need DNS. */
export type TxtLookup = (name: string) => Promise<string[]>;

async function txtRecords(name: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
  try {
    const records = await withTimeout(resolver.resolveTxt(name), `DNS lookup for ${name}`);
    return records.map((parts) => parts.join(''));
  } catch {
    return [];
  } finally {
    resolver.cancel();
  }
}

// DMARC is inherited from the organizational domain. A full public-suffix list is overkill here;
// these are the two-label suffixes our users are likely to send from.
const TWO_LABEL_SUFFIXES = new Set(['ac.uk', 'co.nz', 'co.uk', 'com.au', 'org.uk']);

function dmarcLookupNames(domain: string): string[] {
  const labels = domain.replace(/\.$/, '').toLowerCase().split('.').filter(Boolean);
  // A single label is a top-level suffix, never a place to look for a policy.
  if (labels.length < 2) return [];
  const suffixLength = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  const organizationalLabels = Math.min(labels.length, suffixLength);
  const names: string[] = [];
  // From the exact domain up to the organizational domain, never the suffix itself.
  for (let start = 0; start <= labels.length - organizationalLabels; start++) names.push(`_dmarc.${labels.slice(start).join('.')}`);
  return names;
}

function dmarcPolicy(record: string): string | undefined {
  return /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(record)?.[1]?.toLowerCase();
}

interface DmarcRecord {
  /** The domain whose `_dmarc` record was found; absent when there is none anywhere. */
  foundAt?: string;
  policy?: string;
}

async function findDmarc(domain: string, lookup: TxtLookup): Promise<DmarcRecord> {
  const names = dmarcLookupNames(domain);
  const answers = await Promise.all(names.map(async (name) => ({ name, records: await lookup(name) })));
  for (const answer of answers) {
    const record = answer.records.map((value) => value.trim()).find((value) => /^v=DMARC1(?:\s|;|$)/i.test(value));
    if (record) return { foundAt: answer.name.slice('_dmarc.'.length), policy: dmarcPolicy(record) };
  }
  return {};
}

/** The registrable domain used for DMARC alignment, without a full public-suffix list. */
function organizationalDomain(host: string): string {
  const labels = host.replace(/\.$/, '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return labels.join('.');
  const suffixLength = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-suffixLength).join('.');
}

export async function checkSendingDomains(providers: ProviderRow[], lookup: TxtLookup = txtRecords): Promise<Check[]> {
  const domains = [
    ...new Set(
      providers.map((provider) => provider.from_email?.split('@')[1]?.trim().toLowerCase()).filter((domain): domain is string => !!domain),
    ),
  ];
  if (!domains.length)
    return [
      providers.length
        ? {
            id: 'dns',
            status: 'warn',
            message: 'e-mail providers are configured, but none has a usable from address',
            hint: 'Set a from address on each provider in the admin UI.',
          }
        : { id: 'dns', status: 'ok', message: 'no e-mail providers configured' },
    ];

  // Brand link hosts per from-domain, for the DMARC alignment hint (#188).
  const linksByDomain = new Map<string, Set<string>>();
  for (const provider of providers) {
    const domain = provider.from_email?.split('@')[1]?.trim().toLowerCase();
    if (!domain || !provider.links_host) continue;
    const set = linksByDomain.get(domain) ?? new Set<string>();
    set.add(provider.links_host.toLowerCase());
    linksByDomain.set(domain, set);
  }

  const checks = await Promise.all(
    domains.map(async (domain) => {
      const [spf, dmarc] = await Promise.all([lookup(domain), findDmarc(domain, lookup)]);
      const hasSpf = spf.some((record) => /^v=spf1(?:\s|$)/i.test(record));
      const inherited = dmarc.foundAt && dmarc.foundAt !== domain;
      const inheritedFrom = inherited ? ` (inherited from ${dmarc.foundAt} (p=${dmarc.policy ?? 'none'}))` : '';
      const links = [...(linksByDomain.get(domain) ?? [])];
      const linkNote = links.length ? `; links use ${links.join(', ')}` : '';

      if (!dmarc.foundAt)
        return {
          id: `dns.${domain}`,
          status: 'warn' as const,
          message: `${domain} is missing ${[hasSpf ? null : 'SPF', 'DMARC'].filter(Boolean).join(' and ')}${linkNote}`,
          hint: 'Publish an SPF TXT record (`v=spf1 ...`) and a DMARC TXT record at `_dmarc.<domain>` (or at the organizational domain). DKIM selectors depend on the provider; enable DKIM there.',
        };
      if (dmarc.policy === 'none')
        return {
          id: `dns.${domain}`,
          status: 'warn' as const,
          message: `${domain} has DMARC p=none${inherited ? ` (inherited from ${dmarc.foundAt})` : ''}; it only monitors${linkNote}`,
          hint: 'Move to p=quarantine (then p=reject) once the reports show your legitimate mail passes SPF and DKIM.',
        };
      if (!hasSpf)
        return {
          id: `dns.${domain}`,
          status: 'warn' as const,
          message: `${domain} is missing SPF${inheritedFrom}${linkNote}`,
          hint: 'Publish an SPF TXT record (`v=spf1 ...`). DKIM selectors depend on the provider; enable DKIM there.',
        };
      return {
        id: `dns.${domain}`,
        status: 'ok' as const,
        message: inherited
          ? `SPF found; DMARC for ${domain} inherited from ${dmarc.foundAt} (p=${dmarc.policy ?? 'none'})${linkNote}`
          : `SPF and DMARC records found for ${domain}${linkNote}`,
      };
    }),
  );

  // A List-Unsubscribe link on a different registrable domain is not DMARC-aligned with the From
  // domain. It still works; mailbox providers may weigh it, so warn rather than fail (#188).
  for (const [domain, links] of linksByDomain) {
    const misaligned = [...links].filter((host) => organizationalDomain(host) !== organizationalDomain(domain));
    if (!misaligned.length) continue;
    checks.push({
      id: `brand-domains.alignment.${domain}`,
      status: 'warn',
      message: `${domain} sends, but List-Unsubscribe links use ${misaligned.join(', ')} (a different registrable domain)`,
      hint: `DMARC alignment is stronger when the link host shares the sending domain; use am.${organizationalDomain(domain)} for links and news.${organizationalDomain(domain)} for sending. This is a warning only.`,
    });
  }

  return checks;
}

type EgressTarget = { kind: 'http'; url: string } | { kind: 'tcp'; host: string; port: number };

function egressTarget(adapter: string, config: Record<string, unknown>): EgressTarget | string {
  switch (adapter) {
    case 'brevo':
      return { kind: 'http', url: 'https://api.brevo.com' };
    case 'postmark':
      return { kind: 'http', url: 'https://api.postmarkapp.com' };
    case 'ses': {
      const region = typeof config.region === 'string' ? config.region : '';
      if (!/^[a-z0-9-]+$/.test(region)) return 'SES provider has no valid region in its configuration';
      return { kind: 'http', url: `https://email.${region}.amazonaws.com` };
    }
    case 'cloudflare': {
      const apiBase = typeof config.apiBase === 'string' ? config.apiBase : 'https://api.cloudflare.com/client/v4';
      try {
        new URL(apiBase);
      } catch {
        return 'Cloudflare provider has an invalid apiBase in its configuration';
      }
      return { kind: 'http', url: apiBase };
    }
    case 'smtp': {
      const host = typeof config.host === 'string' ? config.host : '';
      const port = typeof config.port === 'number' ? config.port : 587;
      if (!host) return 'SMTP provider has no host in its configuration';
      return { kind: 'tcp', host, port };
    }
    default:
      return `unknown e-mail adapter ${adapter}`;
  }
}

async function probeHttp(url: string): Promise<number> {
  const deadline = Date.now() + TIMEOUT_MS;
  const attempt = async (method: 'HEAD' | 'GET') => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`egress timed out after ${SECONDS}s`);
    const res = await fetch(url, { method, signal: AbortSignal.timeout(remaining), redirect: 'follow' });
    return res.status;
  };
  // Some API hosts reject HEAD; a GET is still cheap and proves egress works, within the same
  // three-second budget.
  try {
    return await attempt('HEAD');
  } catch {
    return await attempt('GET');
  }
}

export async function checkEgress(providers: ProviderRow[]): Promise<Check[]> {
  const adapters = [...new Set(providers.map((provider) => provider.adapter))];
  if (!adapters.length) return [{ id: 'egress', status: 'ok', message: 'no e-mail providers configured; nothing to reach' }];

  return Promise.all(
    adapters.map(async (adapter) => {
      const id = `egress.${adapter}`;
      if (adapter === 'log') return { id, status: 'ok' as const, message: 'log adapter writes to the log; no network egress' };
      const provider = providers.find((row) => row.adapter === adapter);
      const target = egressTarget(adapter, provider?.config ?? {});
      if (typeof target === 'string')
        return { id, status: 'warn' as const, message: target, hint: 'Fix the provider configuration in the admin UI.' };
      try {
        if (target.kind === 'tcp') {
          await probeTcp(target.host, target.port, `${adapter} SMTP`);
          return { id, status: 'ok' as const, message: `${adapter} SMTP at ${target.host}:${target.port} is reachable` };
        }
        const status = await probeHttp(target.url);
        return { id, status: 'ok' as const, message: `${adapter} API is reachable (HTTP ${status})` };
      } catch (err) {
        return {
          id,
          status: 'fail' as const,
          message: `${adapter} is unreachable: ${messageOf(err)}`,
          hint: 'Allow outbound HTTPS (or SMTP) from the host and check the provider host and port.',
        };
      }
    }),
  );
}

export async function liveChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  let db: Db | undefined;
  try {
    db = createDb({
      adminUrl: config.adminDatabaseUrl,
      appUrl: config.appDatabaseUrl,
      connectionTimeoutMillis: TIMEOUT_MS,
      queryTimeoutMillis: TIMEOUT_MS,
    });
    const postgres = await postgresChecks(db);
    checks.push(...postgres.checks);
    checks.push(await checkClickHouse(config));
    checks.push(await checkNats(config));
    checks.push(await checkValkey(config));

    if (postgres.reachable) {
      checks.push(await checkDataKeyProvider(config, db));
      checks.push(await checkAppRole(config, db));
      checks.push(...(await operationalHealthChecks(db)));
    }

    if (postgres.reachable) {
      const providers = await readProviders(db);
      if (providers) {
        const [dns, egress] = await Promise.all([checkSendingDomains(providers), checkEgress(providers)]);
        checks.push(...dns, ...egress);
      } else {
        checks.push({
          id: 'providers',
          status: 'warn',
          message: 'could not read e-mail providers; sending-domain and egress checks were skipped',
          hint: 'Check the database user and schema, then run `am doctor` again.',
        });
      }
      const brand = await readBrandDomains(db);
      if (brand) checks.push(...(await checkBrandDomains(brand.domains, brand.workspaces, config)));
      else
        checks.push({
          id: 'brand-domains',
          status: 'warn',
          message: 'could not read brand domains; their checks were skipped',
          hint: 'Check the database user and schema, then run `am doctor` again.',
        });
    } else {
      checks.push({
        id: 'providers',
        status: 'warn',
        message: 'sending-domain and egress checks skipped because Postgres is unreachable',
        hint: 'Fix Postgres first, then run `am doctor` again.',
      });
    }
  } catch (err) {
    checks.push({
      id: 'live',
      status: 'fail',
      message: `live checks could not run: ${messageOf(err)}`,
      hint: 'Fix the reported problem and run `am doctor` again.',
    });
  } finally {
    if (db) await db.close().catch(() => {});
  }
  return checks;
}
