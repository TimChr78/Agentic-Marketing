import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureAppRole } from '../src/migrate';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';
import { runScoped } from './run';

// #813: `ensureAppRole` creates the app role NOSUPERUSER NOBYPASSRLS, but the update path only
// changed the password. An operator who points APP_DB_ROLE at a privileged role (by hand, an old
// install or another tool) would run every request with row-level security bypassed. The update
// path must reset the attributes, and when the migration role may not alter a superuser it must
// say so instead of leaving the bypass in place.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

const maintenanceUrl = () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  url.pathname = '/postgres';
  return url.toString();
};

describe.skipIf(!hasTestDatabase())('the app role has no SUPERUSER or BYPASSRLS (#813)', () => {
  it('resets the attributes of a role that already existed', async () => {
    const suffix = randomBytes(4).toString('hex');
    const role = runScoped(`legacy_app_${suffix}`);
    const admin = new pg.Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    try {
      // A privileged role as an old install or a hand-made setup could have left it.
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'legacy-password' SUPERUSER BYPASSRLS`);

      const db = await createDisposableDb('approle', { appRole: role, appRolePassword: 'fixed-app-password' });
      open.push(db);

      const { rows } = await db.db.admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [role],
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      // The migrate ran with the reset attributes, so the app connection still works.
      const appUrl = new URL(db.url.toString());
      appUrl.username = role;
      appUrl.password = 'fixed-app-password';
      const app = new pg.Client({ connectionString: appUrl.toString() });
      await app.connect();
      try {
        expect((await app.query('SELECT current_user')).rows[0]).toEqual({ current_user: role });
      } finally {
        await app.end();
      }
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await admin.end();
    }
  }, 120_000);

  it('refuses an app role that can SET ROLE into a privileged role by membership (0.14.11 round 4)', async () => {
    const suffix = randomBytes(4).toString('hex');
    const app = runScoped(`chain_app_${suffix}`);
    const middle = runScoped(`chain_mid_${suffix}`);
    const privileged = runScoped(`chain_priv_${suffix}`);
    const admin = new pg.Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    try {
      // The reviewer's reproducer: neither NOINHERIT nor an unprivileged middle role stops
      // `SET ROLE`, so app → middle → privileged reaches BYPASSRLS while the app role's own
      // attributes are both false.
      await admin.query(`DROP ROLE IF EXISTS ${app}`);
      await admin.query(`DROP ROLE IF EXISTS ${middle}`);
      await admin.query(`DROP ROLE IF EXISTS ${privileged}`);
      await admin.query(`CREATE ROLE ${app} LOGIN PASSWORD 'chain-password' NOSUPERUSER NOBYPASSRLS NOINHERIT`);
      await admin.query(`CREATE ROLE ${middle} NOSUPERUSER NOBYPASSRLS NOINHERIT`);
      await admin.query(`CREATE ROLE ${privileged} NOSUPERUSER BYPASSRLS NOINHERIT`);
      await admin.query(`GRANT ${middle} TO ${app}`);
      await admin.query(`GRANT ${privileged} TO ${middle}`);

      const attempt = ensureAppRole(admin, { appRole: app, appRolePassword: 'chain-password' });
      await expect(attempt).rejects.toThrow(new RegExp(app));
      await expect(ensureAppRole(admin, { appRole: app, appRolePassword: 'chain-password' })).rejects.toThrow(
        new RegExp(`REVOKE ${privileged} FROM ${app}`),
      );
      // The message names the chain, not only the role at the end of it.
      await expect(ensureAppRole(admin, { appRole: app, appRolePassword: 'chain-password' })).rejects.toThrow(
        new RegExp(`${app} → ${middle} → ${privileged}`),
      );
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${app}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${middle}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${privileged}`).catch(() => {});
      await admin.end();
    }
  }, 60_000);

  it('runs twice on a safe role as a CREATEROLE migration user (0.14.11 round 4)', async () => {
    const suffix = randomBytes(4).toString('hex');
    const migrationRole = runScoped(`mig_createrole_${suffix}`);
    const appRole = runScoped(`safe_app_${suffix}`);
    const admin = new pg.Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    let limited: pg.Client | undefined;
    try {
      // A CREATEROLE, non-superuser migration user, as an operator may use instead of the owner.
      // It creates the app role on the first run and finds it already safe on the second.
      await admin.query(`DROP ROLE IF EXISTS ${migrationRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
      await admin.query(`CREATE ROLE ${migrationRole} LOGIN CREATEROLE PASSWORD 'mig-password' NOSUPERUSER NOBYPASSRLS`);

      const url = new URL(maintenanceUrl());
      url.username = migrationRole;
      url.password = 'mig-password';
      limited = new pg.Client({ connectionString: url.toString() });
      await limited.connect();

      await expect(ensureAppRole(limited, { appRole: appRole, appRolePassword: 'first-password' })).resolves.toBe(appRole);
      // Nothing to reset: naming NOSUPERUSER/NOBYPASSRLS again is what a CREATEROLE user may not
      // do, so the second run must leave them out and still set the password.
      await expect(ensureAppRole(limited, { appRole: appRole, appRolePassword: 'second-password' })).resolves.toBe(appRole);

      const { rows } = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [appRole],
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      const appUrl = new URL(maintenanceUrl());
      appUrl.username = appRole;
      appUrl.password = 'second-password';
      const app = new pg.Client({ connectionString: appUrl.toString() });
      await app.connect();
      try {
        expect((await app.query('SELECT current_user')).rows[0]).toEqual({ current_user: appRole });
      } finally {
        await app.end();
      }
    } finally {
      await limited?.end().catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${appRole}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${migrationRole}`).catch(() => {});
      await admin.end();
    }
  }, 60_000);

  it('reports a clear error when the migration role cannot alter a superuser', async () => {
    const suffix = randomBytes(4).toString('hex');
    const migrationRole = runScoped(`mig_limited_${suffix}`);
    const appRole = runScoped(`priv_app_${suffix}`);
    const admin = new pg.Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    let limited: pg.Client | undefined;
    try {
      // The restricted-role harness from sent-at-migration.test.ts: a CREATEROLE, non-superuser
      // migration role, as an operator may use instead of the owner role.
      await admin.query(`DROP ROLE IF EXISTS ${migrationRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
      await admin.query(`CREATE ROLE ${migrationRole} LOGIN CREATEROLE PASSWORD 'mig-password' NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD 'old-password' SUPERUSER BYPASSRLS`);

      const url = new URL(maintenanceUrl());
      url.username = migrationRole;
      url.password = 'mig-password';
      limited = new pg.Client({ connectionString: url.toString() });
      await limited.connect();

      const attempt = ensureAppRole(limited, { appRole: appRole, appRolePassword: 'new-app-password' });
      await expect(attempt).rejects.toThrow(new RegExp(appRole));
      await expect(ensureAppRole(limited, { appRole: appRole, appRolePassword: 'new-app-password' })).rejects.toThrow(
        /superuser|APP_DB_ROLE/,
      );
    } finally {
      await limited?.end().catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${appRole}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${migrationRole}`).catch(() => {});
      await admin.end();
    }
  }, 60_000);
});
