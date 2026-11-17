import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { closeBounded, databaseReport, testDatabaseUrl } from './harness';

// #1028: a test file whose tests passed must not spend its afterAll timeout on a resource that
// will not close. `closeBounded` stops waiting at the budget, names the steps that are still open
// with what they report, and still runs the steps after them.

const hang = () => new Promise<void>(() => {});

describe('a bounded test-server close (#1028)', () => {
  it('reports the step that never closes, with its own account, and closes the rest', async () => {
    const ran: string[] = [];
    const started = Date.now();
    await expect(
      closeBounded(
        [
          {
            name: 'http',
            close: () => {
              ran.push('http');
            },
          },
          { name: 'workers', close: hang, inspect: () => '2 still running: clickhouse-sink, broadcasts' },
          {
            name: 'postgres',
            close: () => {
              ran.push('postgres');
            },
          },
        ],
        { budgetMs: 1_000, stageMs: 100 },
      ),
    ).rejects.toThrow(/workers \(no close after \d+ms \(2 still running: clickhouse-sink, broadcasts\)\)/);
    expect(ran).toEqual(['http', 'postgres']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('names a step that fails and keeps closing the ones after it', async () => {
    const ran: string[] = [];
    await expect(
      closeBounded(
        [
          {
            name: 'nats',
            close: () => {
              throw new Error('a connection string that must not be repeated');
            },
          },
          {
            name: 'valkey',
            close: () => {
              ran.push('valkey');
            },
          },
        ],
        { budgetMs: 1_000 },
      ),
    ).rejects.toThrow(/failed to close: nats(?![^\n]*connection string)/);
    expect(ran).toEqual(['valkey']);
  });

  it('reports a step it never reached once the budget is spent', async () => {
    // Whichever millisecond the budget runs out in, the later step is reported, not waited for.
    await expect(
      closeBounded(
        [
          { name: 'workers', close: hang },
          { name: 'postgres', close: () => {} },
        ],
        { budgetMs: 50, stageMs: 60 },
      ),
    ).rejects.toThrow(/postgres \((no close after \d+ms|did not start: the budget was spent)\)/);
  });

  it('reports every step as not started when it has no budget at all', async () => {
    await expect(
      closeBounded(
        [
          { name: 'workers', close: () => {} },
          { name: 'postgres', close: () => {} },
        ],
        { budgetMs: 0 },
      ),
    ).rejects.toThrow(/workers \(did not start: the budget was spent\), postgres \(did not start: the budget was spent\)/);
  });

  it('names the backend a stuck pool waits for without any of its SQL', async () => {
    const url = testDatabaseUrl('postgres');
    const pool = new pg.Pool({ connectionString: url.toString(), max: 2, application_name: 'am-close-report-test' });
    const held = await pool.connect();
    // An unlucky statement: a literal password near the start would survive an 80-character cut.
    const sleeping = held
      .query("SELECT pg_sleep(1), 'password=hunter2-not-for-logs' AS secret, 'ada@example.com' AS person")
      .catch(() => {});
    try {
      const report = await databaseReport(url, { admin: pool, app: pool });
      // The backend is still identifiable: state, what it waits on and its application name.
      expect(report).toMatch(/admin 1\/1 busy/);
      expect(report).toMatch(/active /);
      expect(report).toContain('am-close-report-test');
      // But nothing of the statement, near the start or anywhere else (#1028 review).
      expect(report).not.toContain('hunter2');
      expect(report).not.toContain('ada@example.com');
      expect(report).not.toContain('SELECT');
    } finally {
      await sleeping;
      held.release();
      await pool.end();
    }
  }, 10_000);

  it('resolves when every step closes inside the budget', async () => {
    let closed = 0;
    await closeBounded(
      [
        { name: 'workers', close: () => {} },
        {
          name: 'postgres',
          close: async () => {
            closed += 1;
          },
        },
      ],
      { budgetMs: 1_000 },
    );
    expect(closed).toBe(1);
  });
});
