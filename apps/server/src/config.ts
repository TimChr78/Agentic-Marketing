import { z } from 'zod';

// All configuration comes from the environment and is validated at start-up, so a missing or
// malformed setting fails fast with a clear message instead of at the first request.
const Env = z.object({
  ROLE: z.string().default('all').describe('Comma-separated roles: api, worker, scheduler, or all'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.url().optional(),
  DATABASE_URL: z.string().describe('Owner/admin connection, used for migrations and auth tables'),
  APP_DB_PASSWORD: z.string().min(8).describe('Password for the am_app role the command layer uses (row-level security applies)'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters (e.g. `openssl rand -base64 32`)'),
  MASTER_KEY: z.string().describe('Base64 32-byte key-encryption key for secrets (`openssl rand -base64 32`)'),
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
  appUrl.username = 'am_app';
  appUrl.password = e.APP_DB_PASSWORD;
  return {
    roles: new Set(e.ROLE === 'all' ? ['api', 'worker', 'scheduler'] : e.ROLE.split(',').map((r) => r.trim())),
    port: e.PORT,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    adminDatabaseUrl: e.DATABASE_URL,
    appDatabaseUrl: appUrl.toString(),
    appDbPassword: e.APP_DB_PASSWORD,
    authSecret: e.AUTH_SECRET,
    masterKey: e.MASTER_KEY,
    trustedOrigins: e.TRUSTED_ORIGINS?.split(',').map((o) => o.trim()) ?? [],
  };
}
