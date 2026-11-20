import type { Tx } from '@agentic-marketing/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { listChangeEvents, type PublishedSegment } from '../src/membership';

// #1143: a CSV import (50,000 rows) and a snapshot (no cap) both build their change events here.
// The old lookup bound one PostgreSQL parameter per id (65,535 limit) and ran two linear scans per
// person. It now reads chunks of ids as one array parameter and indexes the answer in a Map.

const ws = '00000000-0000-4000-8000-000000000001';
const dialect = new PgDialect();
const segment: PublishedSegment = {
  id: 'seg_00000000000000000000000000000001',
  name: 'Large list',
  version: 1,
  definition: { description: '', mode: 'static' },
};

const profileId = (n: number) => `prf_${n.toString(16).padStart(32, '0')}`;

/** A transaction stub that answers the identifier query with one user id per requested profile. */
function fakeTx() {
  const chunks: string[][] = [];
  const tx = {
    async execute(query: unknown) {
      const { params } = dialect.sqlToQuery(query as never);
      const chunk = params.find((p): p is string[] => Array.isArray(p)) ?? [];
      chunks.push(chunk);
      return { rows: chunk.map((id) => ({ type: 'user_id', value: `user-${id}`, profile_id: id })) };
    },
  } as unknown as Tx;
  return { tx, chunks };
}

describe('membership change events on large lists (#1143)', () => {
  it('reads identifiers in bounded array chunks and returns one event per person', async () => {
    const ids = Array.from({ length: 70_000 }, (_, i) => profileId(i));
    const { tx, chunks } = fakeTx();
    const events = await listChangeEvents(tx, ws, segment, ids, [], 'import');

    expect(events).toHaveLength(ids.length);
    expect(chunks.length).toBe(Math.ceil(ids.length / 5000));
    expect(chunks.every((c) => c.length <= 5000)).toBe(true);
    expect(chunks.flat().sort()).toEqual([...ids].sort());
    expect(events[0]).toMatchObject({ userId: `user-${ids[0]}`, name: 'Segment Entered' });
    expect(events.at(-1)).toMatchObject({ userId: `user-${ids.at(-1)}` });
  });

  it('scales linearly with the number of people, not quadratically', async () => {
    // A ratio between two sizes, not an absolute duration: four times the people should cost about
    // four times the work. The old `.find` per person cost sixteen.
    const time = async (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => profileId(i));
      const { tx } = fakeTx();
      const started = performance.now();
      await listChangeEvents(tx, ws, segment, ids, [], 'import');
      return performance.now() - started;
    };
    // Warm the JIT so the first size does not pay for compilation.
    await time(1000);
    const small = await time(10_000);
    const large = await time(40_000);
    expect(large / Math.max(small, 0.1)).toBeLessThan(8);
  });
});
