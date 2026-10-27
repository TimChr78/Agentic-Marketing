import { fileURLToPath } from 'node:url';
import { isIpOrCidr } from '@agentic-marketing/core';
import { z } from 'zod';

// All configuration comes from the environment and is validated at start-up, so a missing or
// malformed setting fails fast with a clear message instead of at the first request.
const Env = z.object({
  SKIP_MIGRATIONS: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Start without migrating (Kubernetes: a migration job runs before each upgrade)'),
  SKIP_PRE_UPGRADE_BACKUP: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Do not take the automatic Postgres backup before pending migrations run (e.g. when an external backup job covers it)'),
  BACKUP_DIR: z
    .string()
    .optional()
    .describe('Where `am backup` and the pre-upgrade backup write; default: /backups when writable, else ./backups'),
  STRICT_INPUTS: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Reject unknown command input keys instead of accepting them with a warning (roll it out before flipping this)'),
  MCP_TEXT_CONTENT: z
    .enum(['json', 'summary'])
    .default('json')
    .describe('Text block of an MCP tool result: the full result as JSON, or a one-line summary (structuredContent is always complete)'),
  MCP_TOOL_NAME_STYLE: z
    .enum(['dotted', 'underscore'])
    .default('dotted')
    .describe('MCP tool names: command names such as artifacts.list, or underscore names such as artifacts_list'),
  ROLE: z.string().default('all').describe('Comma-separated roles: api, ingest, worker, scheduler, or all'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(
      'Optional second listener that serves only /f, /u, /c, /a, /n, /hooks, /healthz and /readyz; point the public tunnel or proxy here',
    ),
  WEB_DIST: z
    .string()
    .optional()
    .describe('Directory with the built admin UI; default: apps/web/dist in the repo, which is also where the image puts it'),
  PUBLIC_URL: z.url().optional(),
  PUBLIC_LINKS_URL: z
    .url()
    .optional()
    .describe(
      'Base URL for links people follow from e-mails and websites (unsubscribe, clicks, forms, confirmations), e.g. https://martechsignal.com/am when the site proxies /am/* to the platform. Default: PUBLIC_URL',
    ),
  CLIENT_IP_HEADER: z
    .string()
    .default('x-forwarded-for')
    .describe(
      'Headers carrying the client IP, in trust order and comma-separated, e.g. cf-connecting-ip,x-forwarded-for for public traffic through a Cloudflare Tunnel plus LAN/VPN sign-ins; the first address of the first valid header is used',
    ),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default('')
    .refine(
      (value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .every((entry) => !entry || isIpOrCidr(entry)),
      'TRUSTED_PROXY_CIDRS must be a comma-separated list of IP addresses or CIDR ranges',
    )
    .describe(
      'Comma-separated proxy/loopback ranges whose forwarding headers are trusted, e.g. 127.0.0.1/32,::1/128,10.0.0.0/8; empty trusts the forwarded headers from any source (backward compatible)',
    ),
  DATABASE_URL: z.string().describe('Owner/admin connection, used for migrations and auth tables'),
  APP_DB_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('am_app')
    .describe('Name of the row-level-security role; separate installs on one Postgres server need different names'),
  APP_DB_PASSWORD: z.string().min(8).describe('Password for the am_app role the command layer uses (row-level security applies)'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters (e.g. `openssl rand -base64 32`)'),
  KEY_PROVIDER: z
    .enum(['local', 'openbao', 'aws-kms'])
    .default('local')
    .describe('Where the key-encryption key lives: MASTER_KEY (local), OpenBao/Vault Transit, or AWS KMS'),
  MASTER_KEY: z
    .string()
    .optional()
    .describe(
      'Base64 32-byte key-encryption key for secrets (`openssl rand -base64 32`); with another KEY_PROVIDER, the key to migrate from',
    ),
  MASTER_KEY_PREVIOUS: z
    .string()
    .optional()
    .describe('Comma-separated previous master keys, kept only while `cli rotate-keys` re-wraps data keys'),
  OPENBAO_ADDR: z.url().optional().describe('OpenBao or Vault address, e.g. https://bao.internal:8200'),
  OPENBAO_TOKEN: z.string().optional(),
  OPENBAO_TOKEN_FILE: z.string().optional().describe('File with the token (agent sidecar, Kubernetes secret); re-read when rejected'),
  OPENBAO_TRANSIT_MOUNT: z.string().default('transit'),
  OPENBAO_TRANSIT_KEY: z.string().default('agentic-marketing'),
  OPENBAO_NAMESPACE: z.string().optional(),
  AWS_KMS_KEY_ID: z.string().optional().describe('Key id, ARN or alias of a symmetric KMS key'),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  AWS_KMS_ENDPOINT: z.url().optional().describe('A VPC endpoint or a test server instead of kms.<region>.amazonaws.com'),
  CLICKHOUSE_URL: z.url().default('http://localhost:8123').describe('ClickHouse HTTP endpoint, credentials in the URL if needed'),
  CLICKHOUSE_DATABASE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('am'),
  CLICKHOUSE_ROW_POLICIES: z
    .enum(['required', 'auto', 'off'])
    .default('auto')
    .describe('Row policies that limit every ClickHouse query to its workspace: required fails at startup if they cannot be applied'),
  NATS_URL: z.string().default('nats://localhost:4222'),
  NATS_NAMESPACE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('events')
    .describe('Stream and subject prefix on the NATS server'),
  NATS_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24)
    .describe('How long JetStream keeps events (they hold personal traits until processed): long enough to ride out a worker outage'),
  VALKEY_URL: z.string().default('redis://localhost:6379').describe('Valkey (or Redis) for session state and profile snapshots'),
  VALKEY_PREFIX: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('am')
    .describe('Key prefix, so several installs can share one Valkey'),
  EGRESS_ALLOWED_HOSTS: z
    .string()
    .default('')
    .describe(
      'Comma-separated hosts, IPs or CIDR ranges that webhooks and connector actions may reach although private, e.g. "n8n.lan,192.168.1.0/24"',
    ),
  EMAIL_TRACK_CLICKS: z
    .enum(['true', 'false'])
    .default('true')
    .describe('Rewrite links in e-mails to count clicks (open pixels are never added)'),
  ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(5_242_880)
    .describe('Largest asset (image or PDF) the library accepts, in bytes; default 5 MB'),
  RETENTION_UNCONFIRMED_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .default(30)
    .describe('Days before signups that were never confirmed (no consent recorded) are removed'),
  RETENTION_LOG_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .default(180)
    .describe('Days finished webhook and action deliveries and AI call logs are kept'),
  STEP_UP_MAX_FAILURES: z.coerce
    .number()
    .int()
    .min(1)
    .default(5)
    .describe('Wrong passwords allowed when widening an API token inside the window before it locks for a while'),
  STEP_UP_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(900)
    .describe('Window in which wrong password step-ups count towards the token-widening lockout'),
  STEP_UP_LOCKOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(900)
    .describe('How long further token-widening password checks are refused after too many wrong passwords'),
  TRUSTED_ORIGINS: z
    .string()
    .optional()
    .describe('Comma-separated extra origins allowed to call auth endpoints, and identity providers on private addresses'),
  SSO_DOMAIN_VERIFICATION: z
    .enum(['true', 'false'])
    .default('true')
    .describe('Require a DNS TXT record proving an SSO provider owns its e-mail domain'),
});

/** Every key the server understands, for tooling such as `am doctor --env-file`. */
export const ENV_KEYS = Object.keys(Env.shape);

/** Keys without a default and not optional: the ones a fresh install has to provide. */
export const REQUIRED_ENV_KEYS = Object.entries(Env.shape)
  .filter(([, schema]) => !schema.isOptional())
  .map(([key]) => key);

/**
 * A configuration problem an operator can act on. Callers print the message without a stack
 * trace: the stack points at loadConfig, not at anything they can fix.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Turn a zod issue into one short phrase, using the names the operator sees in .env. */
function issueText(issue: z.core.$ZodIssue): string {
  const key = issue.path.map(String).join('.') || 'configuration';
  // Messages written next to the schema (AUTH_SECRET's, TRUSTED_PROXY_CIDRS') already read well.
  if (issue.message.startsWith(`${key} `)) return issue.message;
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? `${key} is missing` : `${key} is invalid`;
    case 'too_small':
      return issue.origin === 'string' ? `${key} must be at least ${issue.minimum} characters` : `${key} must be at least ${issue.minimum}`;
    case 'too_big':
      return issue.origin === 'string' ? `${key} must be at most ${issue.maximum} characters` : `${key} must be at most ${issue.maximum}`;
    case 'invalid_format':
      return issue.format === 'url' ? `${key} must be a valid URL` : `${key} has an invalid format`;
    case 'invalid_value':
      return `${key} must be one of ${issue.values.map(String).join(', ')}`;
    default:
      return `${key}: ${issue.message}`;
  }
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // docker compose passes unset variables as empty strings: treat them as not set.
  const parsed = Env.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    throw new ConfigError(`Configuration is incomplete: ${parsed.error.issues.map(issueText).join(', ')}`);
  }
  const e = parsed.data;
  const missing = (names: string[]) => names.filter((n) => !e[n as keyof typeof e]);
  const needed =
    e.KEY_PROVIDER === 'local'
      ? missing(['MASTER_KEY'])
      : e.KEY_PROVIDER === 'openbao'
        ? [...missing(['OPENBAO_ADDR']), ...(e.OPENBAO_TOKEN || e.OPENBAO_TOKEN_FILE ? [] : ['OPENBAO_TOKEN or OPENBAO_TOKEN_FILE'])]
        : missing(['AWS_KMS_KEY_ID', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  if (needed.length) throw new ConfigError(`Configuration is incomplete: KEY_PROVIDER=${e.KEY_PROVIDER} needs ${needed.join(', ')}`);
  const appUrl = new URL(e.DATABASE_URL);
  appUrl.username = e.APP_DB_ROLE;
  appUrl.password = e.APP_DB_PASSWORD;
  const clientIpHeaders = [
    ...new Set(
      e.CLIENT_IP_HEADER.split(',')
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  return {
    roles: new Set(e.ROLE === 'all' ? ['api', 'ingest', 'worker', 'scheduler'] : e.ROLE.split(',').map((r) => r.trim())),
    port: e.PORT,
    publicPort: e.PUBLIC_PORT,
    // Resolved from this file, never from the working directory: `pnpm start` and the image both
    // run from /app, where the built UI sits next to the server.
    webDist: e.WEB_DIST ?? fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
    skipMigrations: e.SKIP_MIGRATIONS === 'true',
    skipPreUpgradeBackup: e.SKIP_PRE_UPGRADE_BACKUP === 'true',
    backupDir: e.BACKUP_DIR,
    strictInputs: e.STRICT_INPUTS === 'true',
    mcpTextContent: e.MCP_TEXT_CONTENT,
    mcpToolNameStyle: e.MCP_TOOL_NAME_STYLE,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    linksUrl: (e.PUBLIC_LINKS_URL ?? e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    clientIpHeaders: clientIpHeaders.length ? clientIpHeaders : ['x-forwarded-for'],
    clientIpHeader: clientIpHeaders[0] ?? 'x-forwarded-for',
    trustedProxyCidrs: e.TRUSTED_PROXY_CIDRS.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    adminDatabaseUrl: e.DATABASE_URL,
    appDatabaseUrl: appUrl.toString(),
    appDbPassword: e.APP_DB_PASSWORD,
    appDbRole: e.APP_DB_ROLE,
    authSecret: e.AUTH_SECRET,
    masterKey: e.MASTER_KEY,
    keys: {
      provider: e.KEY_PROVIDER,
      openbao: {
        addr: e.OPENBAO_ADDR ?? '',
        token: e.OPENBAO_TOKEN,
        tokenFile: e.OPENBAO_TOKEN_FILE,
        mount: e.OPENBAO_TRANSIT_MOUNT,
        key: e.OPENBAO_TRANSIT_KEY,
        namespace: e.OPENBAO_NAMESPACE,
      },
      awsKms: {
        keyId: e.AWS_KMS_KEY_ID ?? '',
        region: e.AWS_REGION ?? '',
        accessKeyId: e.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: e.AWS_SECRET_ACCESS_KEY ?? '',
        sessionToken: e.AWS_SESSION_TOKEN,
        endpoint: e.AWS_KMS_ENDPOINT,
      },
    },
    previousMasterKeys:
      e.MASTER_KEY_PREVIOUS?.split(',')
        .map((k) => k.trim())
        .filter(Boolean) ?? [],
    clickhouse: { url: e.CLICKHOUSE_URL, database: e.CLICKHOUSE_DATABASE, rowPolicies: e.CLICKHOUSE_ROW_POLICIES },
    nats: { url: e.NATS_URL, namespace: e.NATS_NAMESPACE, retentionHours: e.NATS_RETENTION_HOURS },
    valkey: { url: e.VALKEY_URL, prefix: e.VALKEY_PREFIX },
    trackClicks: e.EMAIL_TRACK_CLICKS === 'true',
    assetMaxBytes: e.ASSET_MAX_BYTES,
    egress: {
      allowedHosts: e.EGRESS_ALLOWED_HOSTS.split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    },
    retention: { unconfirmedDays: e.RETENTION_UNCONFIRMED_DAYS, logDays: e.RETENTION_LOG_DAYS },
    stepUp: {
      maxFailures: e.STEP_UP_MAX_FAILURES,
      windowSeconds: e.STEP_UP_WINDOW_SECONDS,
      lockoutSeconds: e.STEP_UP_LOCKOUT_SECONDS,
    },
    trustedOrigins: e.TRUSTED_ORIGINS?.split(',').map((o) => o.trim()) ?? [],
    sso: { domainVerification: e.SSO_DOMAIN_VERIFICATION === 'true' },
  };
}
