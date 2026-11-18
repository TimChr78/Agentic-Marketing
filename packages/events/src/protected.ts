/**
 * Protected read sources (#1037, 0.17.0 part 2).
 *
 * Every application read of person-linked ClickHouse data goes through a view that removes any
 * row whose subject keys match the workspace's durable erasure ledger. The views are created by
 * packages/events/clickhouse/0009_protected_views.sql; they are not a convenience: a read that
 * names a base table directly bypasses the erasure completion contract, so
 * `packages/events/test/protected-reads-guard.test.ts` fails when a source file does that outside
 * the maintenance paths (sink inserts, erasure sweeps, backfill, migrations).
 *
 * A workspace that has never allocated an erasure generation has nothing to exclude, and the view
 * would still cost a ledger scan plus sixteen subject-key probes on every read. The shared read
 * layer therefore chooses the source once per request: the base table for such a workspace, the
 * protected view for every other. That decision is never cached as a "no": `hasErasures` reads the
 * allocation counter each time (or a positive-only cache), so a read issued after an allocation
 * always takes the protected path, even while its publication is still in flight.
 *
 * The views are parameterized on `ws`, so a protected source is invoked as
 * `events_protected(ws={ws:UUID})` — every caller already passes `{ws:UUID}`.
 *
 * The base tables stay writable by the maintenance paths only. A dedicated ClickHouse read user
 * that holds SELECT on the views and not on the tables is the deployment-level half of this; see
 * docs/architecture/security-and-privacy.md. It is not created yet: the application talks to
 * ClickHouse as one configured user (`CLICKHOUSE_URL`), so this release enforces the split in code
 * and in the guard test, and documents the credential split as the next step.
 */

/** The person-linked tables, and the protected view that must be read instead. */
export const PROTECTED_VIEWS = {
  events: 'events_protected',
  message_events: 'message_events_protected',
  journey_events: 'journey_events_protected',
} as const;

export type PersonTable = keyof typeof PROTECTED_VIEWS;

/** The protected view for a person-linked table. */
export function protectedView(table: PersonTable): string {
  return PROTECTED_VIEWS[table];
}

/** The person-linked tables in the order the views and their migrations list them. */
export const PERSON_TABLES = Object.keys(PROTECTED_VIEWS) as PersonTable[];

/**
 * The `FROM` source a read of a person-linked table uses. `protectedRead` is the workspace's
 * erasure-allocation decision for this request: false only when no erasure has ever been allocated
 * there. The view is invoked with the caller's `{ws:UUID}` parameter, which every read already
 * carries.
 */
export function personReadSource(table: PersonTable, protectedRead: boolean): string {
  return protectedRead ? `${PROTECTED_VIEWS[table]}(ws={ws:UUID})` : table;
}
