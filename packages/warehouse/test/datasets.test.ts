import type { Db, WarehouseDataset } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { DATASETS, readDataset, uncoveredDatasets } from '../src/datasets';

// #374: the incremental windows must read an independent change marker. first_seen never moves
// when a merge re-points an identifier, and consent_state.updated_at is the winning ledger
// record's time, which is routinely older than the export cursor after a rewrite.

const ws = '00000000-0000-4000-8000-000000000001';
const since = '2026-10-01T00:00:00.000Z';
const until = '2026-10-02T00:00:00.000Z';
const dialect = new PgDialect();

function capture() {
  const queries: string[] = [];
  const db = {
    async withWorkspace<T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({
        async execute(query: unknown) {
          queries.push(dialect.sqlToQuery(query as never).sql);
          return { rows: [] };
        },
      });
    },
  } as unknown as Db;
  return { db, queries };
}

async function drain(dataset: 'identifiers' | 'consent') {
  const { db, queries } = capture();
  for await (const _ of readDataset({ db, events: {} as EventStore }, ws, dataset, since, until)) {
    // no rows in this fake
  }
  return queries;
}

describe('warehouse dataset windows', () => {
  it('keys identifiers on the change marker, not first_seen', async () => {
    expect(DATASETS.identifiers.window).toBe('warehouse_changed_at');
    const [query] = await drain('identifiers');
    expect(query).toContain('warehouse_changed_at >');
    expect(query).not.toContain('first_seen >');
    expect(query).toContain('ORDER BY warehouse_changed_at, type, value');
  });

  it('keys consent on the change marker, not the ledger time in updated_at', async () => {
    expect(DATASETS.consent.window).toBe('warehouse_changed_at');
    const [query] = await drain('consent');
    expect(query).toContain('warehouse_changed_at >');
    expect(query).not.toContain('updated_at >');
    expect(query).toContain('ORDER BY warehouse_changed_at, profile_id, purpose, channel');
  });
});

describe('erasure coverage', () => {
  const ids = [{ type: 'user_id' as const, value: 'u-1' }];
  const base = {
    datasets: ['events'] as WarehouseDataset[],
    identifiers: ids,
    keyCount: 1,
    erasedAt: '2026-10-01T00:00:00.000Z',
    trackingSince: '2026-09-01T00:00:00.000Z',
    destinationCreatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('covers events when the captured ids are available', () => {
    expect(uncoveredDatasets(base)).toEqual([]);
  });

  it('leaves events uncovered for a legacy erasure with no captured ids', () => {
    expect(uncoveredDatasets({ ...base, identifiers: [], keyCount: 0, trackingSince: '2026-11-01T00:00:00.000Z' })).toEqual(['events']);
  });

  it('leaves events uncovered when another destination already pruned the keys', () => {
    expect(uncoveredDatasets({ ...base, identifiers: [] })).toEqual(['events']);
  });

  it('is complete when the person never had a user or anonymous id', () => {
    expect(uncoveredDatasets({ ...base, identifiers: [], keyCount: 0 })).toEqual([]);
  });

  it('does not blame a destination created after the erasure', () => {
    expect(
      uncoveredDatasets({
        ...base,
        identifiers: [],
        keyCount: 0,
        trackingSince: '2026-11-01T00:00:00.000Z',
        destinationCreatedAt: '2026-10-05T00:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('does not need event keys when events are not exported', () => {
    expect(uncoveredDatasets({ ...base, datasets: ['profiles'], identifiers: [], keyCount: 0 })).toEqual([]);
  });
});
