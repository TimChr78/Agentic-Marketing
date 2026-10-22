import { z } from 'zod';

// All configuration comes from the environment and is validated at start-up, so a missing or
// malformed setting fails fast with a clear message instead of at the first request.
const Env = z.object({
  ROLE: z.string().default('all').describe('Comma-separated roles: api, ingest, worker, scheduler, or all'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.url().optional(),
  DATABASE_URL: z.string().describe('Owner/admin connection, used for migrations and auth tables'),
  APP_DB_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('am_app')
    .describe('Name of the row-level-security role; separate installs on one Postgres server need different names'),
  APP_DB_PASSWORD: z.string().min(8).describe('Password for the am_app role the command layer uses (row-level security applies)'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters (e.g. `openssl rand -base64 32`)'),
  MASTER_KEY: z.string().describe('Base64 32-byte key-encryption key for secrets (`openssl rand -base64 32`)'),
  MASTER_KEY_PREVIOUS: z
    .string()
    .optional()
    .describe('Comma-separated previous master keys, kept only while `cli rotate-keys` re-wraps data keys'),
  CLICKHOUSE_URL: z.url().default('http://localhost:8123').describe('ClickHouse HTTP endpoint, credentials in the URL if needed'),
  CLICKHOUSE_DATABASE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('am'),
  NATS_URL: z.string().default('nats://localhost:4222'),
  NATS_NAMESPACE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('events')
    .describe('Stream and subject prefix on the NATS server'),
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
  TRUSTED_ORIGINS: z.string().optional().describe('Comma-separated extra origins allowed to call auth endpoints'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const appUrl = new URL(e.DATABASE_URL);
  appUrl.username = e.APP_DB_ROLE;
  appUrl.password = e.APP_DB_PASSWORD;
  return {
    roles: new Set(e.ROLE === 'all' ? ['api', 'ingest', 'worker', 'scheduler'] : e.ROLE.split(',').map((r) => r.trim())),
    port: e.PORT,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    adminDatabaseUrl: e.DATABASE_URL,
    appDatabaseUrl: appUrl.toString(),
    appDbPassword: e.APP_DB_PASSWORD,
    appDbRole: e.APP_DB_ROLE,
    authSecret: e.AUTH_SECRET,
    masterKey: e.MASTER_KEY,
    previousMasterKeys:
      e.MASTER_KEY_PREVIOUS?.split(',')
        .map((k) => k.trim())
        .filter(Boolean) ?? [],
    clickhouse: { url: e.CLICKHOUSE_URL, database: e.CLICKHOUSE_DATABASE },
    nats: { url: e.NATS_URL, namespace: e.NATS_NAMESPACE },
    valkey: { url: e.VALKEY_URL, prefix: e.VALKEY_PREFIX },
    trackClicks: e.EMAIL_TRACK_CLICKS === 'true',
    egress: {
      allowedHosts: e.EGRESS_ALLOWED_HOSTS.split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    },
    trustedOrigins: e.TRUSTED_ORIGINS?.split(',').map((o) => o.trim()) ?? [],
  };
}
