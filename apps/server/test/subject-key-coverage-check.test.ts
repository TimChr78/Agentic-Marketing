import type { Db } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import { checkSubjectKeyCoverage, type SubjectKeyCoverageCheckDeps } from '../src/ops/checks';

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
