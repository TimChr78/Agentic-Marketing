import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/pool';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from './disposable';

// pg emits a failure of an IDLE pooled connection (a server restart, an administrator terminating
// it) on the pool itself. Without an `error` listener Node treats that as an unhandled 'error'
// event and exits the whole process, even though the pool would only replace the broken client.

const appUrl = (url: URL) => {
  const app = new URL(url);
  app.username = APP_ROLE.appRole;
  app.password = APP_ROLE.appRolePassword;
  return app.toString();
};

describe.skipIf(!hasTestDatabase())('the connection pools', () => {
  let current: Awaited<ReturnType<typeof createDisposableDb>>;

  beforeAll(async () => {
    current = await createDisposableDb('pool');
  });

  afterAll(async () => {
    await current?.close();
  });

  it('survives an idle connection being terminated and reports it', async () => {
    const reported: string[] = [];
    const db = createDb({
      adminUrl: current.url.toString(),
      appUrl: appUrl(current.url),
      poolSize: 2,
      onIdleError: (_err, pool) => reported.push(pool),
    });
    try {
      // Leave one idle client in the app pool, then terminate it from the owner connection.
      await db.app.query('SELECT 1');
      await current.db.admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND datname = current_database() AND pid <> pg_backend_pid()',
        [APP_ROLE.appRole],
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(reported).toContain('app');
      // The pool discards the broken client: the next query still works.
      await expect(db.app.query('SELECT 1')).resolves.toBeTruthy();
    } finally {
      await db.close();
    }
  });
});
