import { describe, expect, it, vi } from 'vitest';
import { erasureLedgerChecker } from '../src/erasureCleanup';
import type { Db } from '../src/pool';

// #1037 part 2 review: the read layer's fast path is decided by the durable ledger, and the
// decision must never cache a "no" (a later erasure has to take effect on the next read), must
// bound what it remembers, and must fail closed with one explicit report when the database is
// unreachable.

const fakeDb = (rows: (workspaceId: string) => { rows: unknown[] }) => {
  const query = vi.fn(async (_sql: string, params?: unknown[]) => rows(String(params?.[0])));
  return { db: { admin: { query } } as unknown as Db, query };
};

describe('the erasure ledger check (#1037 part 2)', () => {
  it('never caches a negative, so an erasure takes effect on the next read', async () => {
    let present = false;
    const { db, query } = fakeDb(() => ({ rows: present ? [{ present: 1 }] : [] }));
    const hasErasures = erasureLedgerChecker(db);

    expect(await hasErasures('ws_a')).toBe(false);
    expect(await hasErasures('ws_a')).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);

    present = true;
    expect(await hasErasures('ws_a')).toBe(true);
    // A positive is permanent: nothing prunes `erasure_keys`.
    expect(await hasErasures('ws_a')).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('bounds the positive cache and evicts the least recently read workspace', async () => {
    const seen: string[] = [];
    const { db, query } = fakeDb((workspaceId) => {
      seen.push(workspaceId);
      return { rows: [{ present: 1 }] };
    });
    const hasErasures = erasureLedgerChecker(db, { cacheMax: 2 });

    await hasErasures('ws_a');
    await hasErasures('ws_b');
    // Touch ws_a, so ws_b becomes the least recently read.
    await hasErasures('ws_a');
    await hasErasures('ws_c');
    const queries = query.mock.calls.length;
    await hasErasures('ws_a');
    expect(query.mock.calls.length).toBe(queries);
    await hasErasures('ws_b');
    expect(query.mock.calls.length).toBe(queries + 1);

    // ws_a was touched, so ws_b is the one evicted by ws_c; its next read asks again.
    expect(seen).toEqual(['ws_a', 'ws_b', 'ws_c', 'ws_b']);
  });

  it('fails closed with an explicit, once-reported error', async () => {
    const failure = new Error('connection refused');
    const { db } = fakeDb(() => {
      throw failure;
    });
    const onError = vi.fn();
    const hasErasures = erasureLedgerChecker(db, { onError });

    await expect(hasErasures('ws_a')).rejects.toThrow(/erasure ledger.*fail closed/);
    await expect(hasErasures('ws_a')).rejects.toMatchObject({ cause: failure });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
