import { VERSION } from '../version';

// When each environment variable first appeared, so `am doctor --env-file` can say what is new
// *for this install* instead of calling every variable added since 0.1.0 new. The git history of
// .env.example and src/config.ts is the source (first commit that mentions the key, mapped to the
// first release tag containing it); CHANGELOG.md's "Upgrading from" blocks are the cross-check.
// A new variable must be added here: a test fails otherwise.
export const ENV_SINCE: Record<string, string> = {
  // 0.1.0
  APP_DB_PASSWORD: '0.1.0',
  APP_DB_ROLE: '0.1.0',
  AUTH_SECRET: '0.1.0',
  AWS_ACCESS_KEY_ID: '0.1.0',
  AWS_KMS_ENDPOINT: '0.1.0',
  AWS_KMS_KEY_ID: '0.1.0',
  AWS_REGION: '0.1.0',
  AWS_SECRET_ACCESS_KEY: '0.1.0',
  AWS_SESSION_TOKEN: '0.1.0',
  CLICKHOUSE_DATABASE: '0.1.0',
  CLICKHOUSE_ROW_POLICIES: '0.1.0',
  CLICKHOUSE_URL: '0.1.0',
  CLIENT_IP_HEADER: '0.1.0',
  DATABASE_URL: '0.1.0',
  EGRESS_ALLOWED_HOSTS: '0.1.0',
  EMAIL_TRACK_CLICKS: '0.1.0',
  KEY_PROVIDER: '0.1.0',
  MASTER_KEY: '0.1.0',
  MASTER_KEY_PREVIOUS: '0.1.0',
  NATS_NAMESPACE: '0.1.0',
  NATS_RETENTION_HOURS: '0.1.0',
  NATS_URL: '0.1.0',
  OPENBAO_ADDR: '0.1.0',
  OPENBAO_NAMESPACE: '0.1.0',
  OPENBAO_TOKEN: '0.1.0',
  OPENBAO_TOKEN_FILE: '0.1.0',
  OPENBAO_TRANSIT_KEY: '0.1.0',
  OPENBAO_TRANSIT_MOUNT: '0.1.0',
  OTEL_EXPORTER_OTLP_ENDPOINT: '0.1.0',
  PORT: '0.1.0',
  POSTGRES_PASSWORD: '0.1.0',
  PUBLIC_LINKS_URL: '0.1.0',
  PUBLIC_URL: '0.1.0',
  RETENTION_LOG_DAYS: '0.1.0',
  RETENTION_UNCONFIRMED_DAYS: '0.1.0',
  ROLE: '0.1.0',
  SKIP_MIGRATIONS: '0.1.0',
  SSO_DOMAIN_VERIFICATION: '0.1.0',
  TRUSTED_ORIGINS: '0.1.0',
  VALKEY_PREFIX: '0.1.0',
  VALKEY_URL: '0.1.0',

  // 0.1.1
  AM_BOOTSTRAP_PASSWORD: '0.1.1',
  AM_BUILD_IMAGE: '0.1.1',
  AM_PORT: '0.1.1',
  AM_RESET_PASSWORD: '0.1.1',
  AM_VERSION: '0.1.1',
  CLICKHOUSE_MEM_LIMIT: '0.1.1',
  TRUSTED_PROXY_CIDRS: '0.1.1',
  WEB_DIST: '0.1.1',

  // 0.1.2
  PUBLIC_PORT: '0.1.2',

  // 0.2.0
  ASSET_MAX_BYTES: '0.2.0',
  MCP_TEXT_CONTENT: '0.2.0',
  MCP_TOOL_NAME_STYLE: '0.2.0',
  STRICT_INPUTS: '0.2.0',

  // 0.2.1–0.2.3 added no environment variables.

  // 0.2.4
  BACKUP_CRON: '0.2.4',
  BACKUP_DIR: '0.2.4',
  BACKUP_KEEP_DAYS: '0.2.4',
  PUBLIC_BIND: '0.2.4',
  SKIP_PRE_UPGRADE_BACKUP: '0.2.4',

  // 0.2.6 (issue #61)
  STEP_UP_LOCKOUT_SECONDS: '0.2.6',
  STEP_UP_MAX_FAILURES: '0.2.6',
  STEP_UP_WINDOW_SECONDS: '0.2.6',

  // 0.3.0 (issue #210)
  ERASURE_GRACE_HOURS: '0.3.0',
};

/**
 * Variables docker-compose.yml puts in the app container itself (literal values, not `${…}`
 * references to .env), so a .env missing them is not broken. Keep in sync with its `environment`.
 */
export const SUPPLIED_BY_COMPOSE = new Set(['BACKUP_DIR', 'CLICKHOUSE_URL', 'DATABASE_URL', 'NATS_URL', 'PORT', 'ROLE', 'VALKEY_URL']);

/** Developer-only wiring: never asked of an installed .env. */
export const INTERNAL_ENV_KEYS = new Set(['TRUSTED_ORIGINS', 'WEB_DIST']);

/** Compose's own variables (COMPOSE_FILE, DOCKER_HOST, …) are not configuration for the app. */
export function isComposeOrDockerKey(key: string): boolean {
  return key.startsWith('COMPOSE_') || key.startsWith('DOCKER_');
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare release versions; null when either is not a version (a tag such as "dev"). */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const difference = left[i] - right[i];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Keys introduced after `from` and no later than the running version. Null if `from` is not a version. */
export function envKeysSince(from: string, current = VERSION): string[] | null {
  if (compareVersions(from, current) === null) return null;
  return Object.entries(ENV_SINCE)
    .filter(([, since]) => {
      const afterFrom = compareVersions(since, from);
      const atOrBeforeCurrent = compareVersions(since, current);
      return afterFrom !== null && afterFrom > 0 && atOrBeforeCurrent !== null && atOrBeforeCurrent <= 0;
    })
    .map(([key]) => key)
    .sort();
}
