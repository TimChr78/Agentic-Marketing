import { describe, expect, it } from 'vitest';
import { invalidDimensionMessage } from '../src/compile';
import { type QueryInput, queryInput, runAnalyticsQuery } from '../src/query';
import { MEASURES } from '../src/registry';

// Validation happens before anything touches Postgres or ClickHouse, so these tests can use a deps
// object that fails loudly if it is ever reached. That keeps the unit test honest: an accepted
// query would otherwise need a database.

const touched = () =>
  new Proxy(
    {},
    {
      get() {
        throw new Error('the database was touched');
      },
    },
  ) as never;

const deps = () => ({ tx: touched(), events: touched(), workspaceId: 'ws_01' });

const query = (overrides: Partial<QueryInput> = {}): QueryInput => ({
  measures: ['email.sent'],
  dimensions: [],
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
  limit: 100,
  ...overrides,
});

const rejects = async (overrides: Partial<QueryInput>, message: string | RegExp) => {
  const promise = runAnalyticsQuery(deps(), query(overrides));
  await expect(promise).rejects.toMatchObject({ name: 'AppError', code: 'invalid_input' });
  await expect(promise).rejects.toThrow(message);
};

describe('query validation', () => {
  it('rejects an unknown measure and lists the catalogue', async () => {
    await rejects({ measures: ['email.nope'] }, /Unknown measure "email.nope"\. Available measures: email\.sent,/);
  });

  it('rejects measures that read different sources in one query', async () => {
    await rejects(
      { measures: ['email.sent', 'journey.entered'] },
      'These measures read different sources (message_events and journey_events); query one source at a time.',
    );
  });

  it('rejects an unknown dimension', async () => {
    await rejects({ dimensions: ['fortnight'] }, /Unknown dimension "fortnight"\. Available dimensions: day,/);
  });

  it('rejects a breakdown the measure does not support, naming the ones it does', async () => {
    await rejects({ measures: ['email.sent'], dimensions: ['segment'] }, invalidDimensionMessage(MEASURES['email.sent']!, 'segment'));
  });

  it('rejects a filter that does not apply to the source', async () => {
    await rejects({ filters: { name: ['Order Completed'] } }, /The "name" filter does not apply to message_events/);
    await rejects(
      { measures: ['conversions'], filters: { channel: ['email'] } },
      'The "channel" filter does not apply to events. It supports: name.',
    );
  });

  it('rejects an empty filter after trimming', async () => {
    await rejects({ filters: { template: ['   '] } }, 'The "template" filter needs at least one value.');
  });

  it('rejects an order key that is not one of the query’s measures or dimensions', async () => {
    await rejects(
      { measures: ['email.sent'], order: { by: 'email.clicked', dir: 'desc' } },
      "order.by must be one of the query's measures or dimensions: email.sent.",
    );
  });

  it('requires from to be before to', async () => {
    await rejects({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }, 'from must be before to.');
    await rejects({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }, 'from must be before to.');
  });

  it('caps the range at 400 days', async () => {
    await rejects({ from: '2025-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' }, 'The time range may be at most 400 days.');
  });

  it('reaches the database only once the query is valid', async () => {
    // Negative control for the tests above: a valid query is not rejected by validation, so it
    // proceeds to the (deliberately hostile) deps.
    await expect(runAnalyticsQuery(deps(), query())).rejects.toThrow('the database was touched');
  });
});

describe('query input schema', () => {
  it('applies the documented defaults', () => {
    const parsed = queryInput.parse({ measures: ['email.sent'], from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' });
    expect(parsed).toMatchObject({ dimensions: [], limit: 1000 });
    expect(parsed.filters).toBeUndefined();
  });

  it('limits a query to ten measures and three dimensions', () => {
    expect(
      queryInput.safeParse({ measures: Array(11).fill('email.sent'), from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }).success,
    ).toBe(false);
    expect(
      queryInput.safeParse({
        measures: ['email.sent'],
        dimensions: ['day', 'week', 'month', 'channel'],
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-02T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects an out-of-range limit or a non-ISO date', () => {
    const base = { measures: ['email.sent'], from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' };
    expect(queryInput.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(queryInput.safeParse({ ...base, limit: 5001 }).success).toBe(false);
    expect(queryInput.safeParse({ ...base, limit: 12.5 }).success).toBe(false);
    expect(queryInput.safeParse({ ...base, from: 'yesterday' }).success).toBe(false);
  });

  it('is strict about filter keys', () => {
    expect(
      queryInput.safeParse({
        measures: ['email.sent'],
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        filters: { recipient: 'ada@example.com' },
      }).success,
    ).toBe(false);
  });

  it('accepts a filter as one string or a non-empty list', () => {
    const base = { measures: ['email.sent'], from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' };
    expect(queryInput.safeParse({ ...base, filters: { template: 'eml_a' } }).success).toBe(true);
    expect(queryInput.safeParse({ ...base, filters: { template: ['eml_a', 'eml_b'] } }).success).toBe(true);
    expect(queryInput.safeParse({ ...base, filters: { template: [] } }).success).toBe(false);
    expect(queryInput.safeParse({ ...base, filters: { template: '' } }).success).toBe(false);
  });
});
