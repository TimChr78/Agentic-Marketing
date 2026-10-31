import { Resolver } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { isMcpResourceUrlAllowed } from '@agentic-marketing/auth';
import { createDb, type Db } from '@agentic-marketing/db';
import { valkeyHotState } from '@agentic-marketing/hotstate';
import { type Config, ENV_KEYS, loadConfig, REQUIRED_ENV_KEYS } from '../config';
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
      message: 'TRUSTED_PROXY_CIDRS is empty; forwarded headers are trusted from any source',
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
}

async function migrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((file) => file.endsWith('.sql')).sort();
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
  return { checks, reachable: true };
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

async function readProviders(db: Db): Promise<ProviderRow[] | null> {
  try {
    const { rows } = await withTimeout(
      db.admin.query<ProviderRow>('SELECT adapter, from_email, config FROM email_providers WHERE enabled = true'),
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

  return Promise.all(
    domains.map(async (domain) => {
      const [spf, dmarc] = await Promise.all([lookup(domain), findDmarc(domain, lookup)]);
      const hasSpf = spf.some((record) => /^v=spf1(?:\s|$)/i.test(record));
      const inherited = dmarc.foundAt && dmarc.foundAt !== domain;
      const inheritedFrom = inherited ? ` (inherited from ${dmarc.foundAt} (p=${dmarc.policy ?? 'none'}))` : '';

      if (!dmarc.foundAt)
        return {
          id: `dns.${domain}`,
          status: 'warn' as const,
          message: `${domain} is missing ${[hasSpf ? null : 'SPF', 'DMARC'].filter(Boolean).join(' and ')}`,
          hint: 'Publish an SPF TXT record (`v=spf1 ...`) and a DMARC TXT record at `_dmarc.<domain>` (or at the organizational domain). DKIM selectors depend on the provider; enable DKIM there.',
        };
      if (dmarc.policy === 'none')
        return {
          id: `dns.${domain}`,
          status: 'warn' as const,
          message: `${domain} has DMARC p=none${inherited ? ` (inherited from ${dmarc.foundAt})` : ''}; it only monitors`,
          hint: 'Move to p=quarantine (then p=reject) once the reports show your legitimate mail passes SPF and DKIM.',
        };
      if (!hasSpf)
        return {
          id: `dns.${domain}`,
          status: 'warn' as const,
          message: `${domain} is missing SPF${inheritedFrom}`,
          hint: 'Publish an SPF TXT record (`v=spf1 ...`). DKIM selectors depend on the provider; enable DKIM there.',
        };
      return {
        id: `dns.${domain}`,
        status: 'ok' as const,
        message: inherited
          ? `SPF found; DMARC for ${domain} inherited from ${dmarc.foundAt} (p=${dmarc.policy ?? 'none'})`
          : `SPF and DMARC records found for ${domain}`,
      };
    }),
  );
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

    if (postgres.reachable) checks.push(...(await operationalHealthChecks(db)));

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
