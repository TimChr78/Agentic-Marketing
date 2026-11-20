import { newId } from '@agentic-marketing/core';
import type { EventStore } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { readDataset } from '../src/datasets';

// #1138: a `timestamptz` cursor decoded into a JS Date keeps milliseconds only. With a page whose
// rows share a microsecond, the next page re-reads them (duplicates, and an infinite export when
// the whole page shares the timestamp). The exported cursor is text at full microsecond precision.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws = '';

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('warehouse_pagination');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('warehouse keyset pagination', () => {
  it('terminates and yields each profile once when a page shares one microsecond', async () => {
    const ids = Array.from({ length: 5 }, () => newId('prf'));
    // One statement, one value: every row shares the microsecond, as a bulk import or migration does.
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, updated_at, first_seen, last_seen, created_at)
       SELECT $1, unnest($2::text[]), '2026-01-01T00:00:00.123456Z'::timestamptz,
              '2026-01-01T00:00:00.123456Z'::timestamptz, '2026-01-01T00:00:00.123456Z'::timestamptz,
              '2026-01-01T00:00:00.123456Z'::timestamptz`,
      [ws, ids],
    );

    const seen: string[] = [];
    let batches = 0;
    // A small page makes the boundary land inside the shared microsecond. Bail out on a runaway
    // read so a regression fails instead of hanging the suite.
    for await (const rows of readDataset(
      { db: d.db, events: {} as EventStore },
      ws,
      'profiles',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z',
      { page: 2 },
    )) {
      seen.push(...rows.map((r) => String(r.profile_id)));
      if (++batches > 20) break;
    }

    expect(new Set(seen).size).toBe(ids.length);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(batches).toBe(3);
  }, 120_000);
});
