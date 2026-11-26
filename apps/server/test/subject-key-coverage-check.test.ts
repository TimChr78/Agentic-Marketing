import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import { checkSubjectKeyCoverage, type SubjectKeyCoverageCheckDeps } from '../src/ops/checks';

/**
 * A ClickHouse HTTP endpoint that rejects the `SQL_workspace` setting exactly as a server without the
 * `SQL_` custom-settings prefix does, and answers every other query with zero rows. Without the
 * configured `required` mode the doctor counted those empty answers as complete coverage.
 */
async function unknownSettingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.has('SQL_workspace')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end("Code: 115. DB::Exception: Unknown setting 'SQL_workspace'. (UNKNOWN_SETTING)");
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// #1037 part 1: the doctor check is bounded. An unfinished count must report unknown/info, never
// `ok`, because a timed-out query is not evidence that every historical row is covered.

const db = { admin: { query: async () => ({ rows: [{ id: 'ws_1' }] }) } } as unknown as Db;
const config = {} as Config;
const deps = (store: NonNullable<SubjectKeyCoverageCheckDeps['store']>, timeoutMs = 5000) => ({ store, timeoutMs });

describe('subject-key coverage doctor check (#1037)', () => {
  it('reports ok only when a completed count is zero', async () => {
    const check = await checkSubjectKeyCoverage(
      config,
      db,
      deps({ subjectKeyCoverage: async () => ({ pending: 0, tables: [] }), close: async () => {} }),
    );
    expect(check).toMatchObject({ id: 'clickhouse.subject-keys', status: 'ok' });
  });

  it('reports a completed non-zero count as warn with counts only', async () => {
    const check = await checkSubjectKeyCoverage(
      config,
      db,
      deps({
        subjectKeyCoverage: async () => ({
          pending: 3,
          tables: [{ table: 'events', workspaceId: 'ws_1', pending: 3 }],
        }),
        close: async () => {},
      }),
    );
    expect(check).toMatchObject({ id: 'clickhouse.subject-keys', status: 'warn' });
    expect(check.message).toContain('3 historical row(s)');
    expect(check.message).toContain('events: 3');
    expect(check.message).not.toContain('ws_1');
  });

  // #1225 review: the check built its own store without the configured row-policy mode. With
  // policies installed and a server that no longer takes `SQL_workspace`, every read is hidden by
  // the policy, so zero rows looked like full coverage and the doctor reported ok.
  it('reports unknown, not ok, when required policies meet a server that rejects SQL_workspace', async () => {
    const stub = await unknownSettingServer();
    try {
      const check = await checkSubjectKeyCoverage(
        { clickhouse: { url: stub.url, database: 'am', rowPolicies: 'required' } } as unknown as Config,
        db,
      );
      expect(check).toMatchObject({ id: 'clickhouse.subject-keys', status: 'info' });
      expect(check.message).toMatch(/SQL_workspace|refusing to read/);
    } finally {
      await stub.close();
    }
  });

  it('reports unknown, not ok, when the count cannot finish', async () => {
    const check = await checkSubjectKeyCoverage(
      config,
      db,
      deps({ subjectKeyCoverage: () => new Promise(() => {}), close: async () => {} }, 20),
    );
    expect(check).toMatchObject({ id: 'clickhouse.subject-keys', status: 'info' });
    expect(check.message).toMatch(/unknown/i);
    expect(check.message).toMatch(/timed out/i);
  });
});
