// Spike configuration. Defaults match the local Postgres set up in FINDINGS.md.
export const config = {
  port: Number(process.env.PORT ?? 3100),
  get baseUrl() {
    return process.env.PUBLIC_URL ?? `http://localhost:${this.port}`;
  },
  secret: process.env.AUTH_SECRET ?? 'spike-secret-change-me-spike-secret-change-me',
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am',
  appDatabaseUrl: process.env.APP_DATABASE_URL ?? 'postgres://am_app:am_app@localhost:5432/am',
};
