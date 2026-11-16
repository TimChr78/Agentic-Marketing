import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { concurrentIndexNames, isNoTransaction } from '../src/migrate';
import { createDisposableDb, hasTestDatabase } from './disposable';

// #941 review: the column changes are transactional, but a normal CREATE INDEX inside them would
// hold an exclusive lock for the whole build. The index lives in its own no-transaction migration
// and is built CONCURRENTLY.

const dir = new URL('../migrations/', import.meta.url);
const migration = (name: string) => readFileSync(new URL(name, dir), 'utf8');

describe('AI billing-usage migrations (#941 review)', () => {
  it('keeps the columns in 0097 and builds the usage index concurrently in 0098', () => {
    const columns = migration('0097_ai_billing_usage.sql');
    expect(columns).toContain('ADD COLUMN IF NOT EXISTS billed_at');
    expect(columns).not.toMatch(/CREATE INDEX/i);

    const index = migration('0098_ai_calls_provider_billed_index.sql');
    expect(isNoTransaction(index)).toBe(true);
    expect(concurrentIndexNames(index)).toContain('ai_calls_provider_billed');
    expect(index).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_calls_provider_billed/);
  });

  it.skipIf(!hasTestDatabase())('leaves a valid index at the head', async () => {
    const d = await createDisposableDb('ai_billing_index');
    try {
      const { rows } = await d.db.admin.query<{ name: string; valid: boolean }>(
        `SELECT c.relname AS name, i.indisvalid AS valid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'ai_calls_provider_billed'`,
      );
      expect(rows).toEqual([{ name: 'ai_calls_provider_billed', valid: true }]);
    } finally {
      await d.close().catch(() => undefined);
    }
  });
});
