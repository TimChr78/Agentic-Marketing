import type { Db, WarehouseDataset } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { type SQL, sql } from 'drizzle-orm';

// What leaves for the warehouse. Nothing here is personal data in the clear: profiles carry only
// their non-personal traits (personal ones are sealed per person and stay behind), identifiers
// only the pseudonymous user and anonymous ids, never e-mail or phone hashes.
//
// Incremental datasets are read in a window (cursor, until] of a timestamp column, page by page;
// `until` lags a little behind now, so rows committed or sunk late still fall in a later window.

export type Row = Record<string, unknown>;

export interface DatasetSpec {
  /** Columns and their Postgres types, the first ones forming the key (after workspace_id). */
  columns: Record<string, string>;
  key: string[];
  /** Incremental (a window on a timestamp) or a full snapshot each run. */
  mode: 'incremental' | 'snapshot';
  /**
   * The timestamp column an incremental export reads. It is a change marker, not a business
   * timestamp: merges and consent rewrites bump it without rewriting first_seen/updated_at.
   */
  window?: string;
}

export const DATASETS: Record<WarehouseDataset, DatasetSpec> = {
  profiles: {
    columns: {
      profile_id: 'text',
      merged_into: 'text',
      traits: 'jsonb',
      first_seen: 'timestamptz',
      last_seen: 'timestamptz',
      updated_at: 'timestamptz',
    },
    key: ['profile_id'],
    mode: 'incremental',
    window: 'updated_at',
  },
  identifiers: {
    columns: { type: 'text', value: 'text', profile_id: 'text', first_seen: 'timestamptz' },
    key: ['type', 'value'],
    mode: 'incremental',
    window: 'warehouse_changed_at',
  },
  consent: {
    columns: { profile_id: 'text', purpose: 'text', channel: 'text', status: 'text', basis: 'text', updated_at: 'timestamptz' },
    key: ['profile_id', 'purpose', 'channel'],
    mode: 'incremental',
    window: 'warehouse_changed_at',
  },
  segment_memberships: {
    columns: { segment_id: 'text', profile_id: 'text', since: 'timestamptz' },
    key: ['segment_id', 'profile_id'],
    mode: 'snapshot',
  },
  events: {
    columns: {
      event_id: 'text',
      type: 'text',
      name: 'text',
      timestamp: 'timestamptz',
      received_at: 'timestamptz',
      anonymous_id: 'text',
      user_id: 'text',
      properties: 'jsonb',
      context: 'jsonb',
    },
    key: ['event_id'],
    mode: 'incremental',
  },
  message_events: {
    columns: {
      message_id: 'text',
      event_id: 'text',
      type: 'text',
      at: 'timestamptz',
      profile_id: 'text',
      channel: 'text',
      purpose: 'text',
      template_id: 'text',
      journey_id: 'text',
      reason: 'text',
      url: 'text',
    },
    key: ['message_id', 'event_id', 'type'],
    mode: 'incremental',
  },
};

const PAGE = 5000;

/** Postgres rows of a workspace, page by page in key order (keyset pagination). */
async function* pgPages(db: Db, ws: string, select: SQL, where: SQL, keyCols: string[]): AsyncGenerator<Row[]> {
  let after: unknown[] | null = null;
  const keys = sql.raw(keyCols.join(', '));
  for (;;) {
    const page: SQL = after
      ? sql`${select} WHERE ${where} AND (${keys}) > (${sql.join(
          after.map((v) => sql`${v}`),
          sql`, `,
        )}) ORDER BY ${keys} LIMIT ${PAGE}`
      : sql`${select} WHERE ${where} ORDER BY ${keys} LIMIT ${PAGE}`;
    const rows = await db.withWorkspace(ws, async (tx) => (await tx.execute<Row>(page)).rows);
    if (!rows.length) return;
    yield rows;
    if (rows.length < PAGE) return;
    const last = rows[rows.length - 1];
    after = keyCols.map((c) => last[c] ?? last.profile_id);
  }
}

/** ClickHouse rows of a workspace in batches (streamed). */
async function* chBatches(events: EventStore, ws: string, query: string, params: Record<string, unknown>): AsyncGenerator<Row[]> {
  const rs = await events.client.query({
    query,
    query_params: { ws, ...params },
    format: 'JSONEachRow',
    clickhouse_settings: (await events.settingsFor(ws)) as never,
  });
  let batch: Row[] = [];
  for await (const rows of rs.stream<Row>())
    for (const r of rows) {
      batch.push(r.json());
      if (batch.length >= PAGE) {
        yield batch;
        batch = [];
      }
    }
  if (batch.length) yield batch;
}

const chTime = (iso: string) => iso.replace('T', ' ').replace('Z', '');
const toIso = (v: unknown) => `${String(v).replace(' ', 'T')}Z`;

/** Rows of a dataset changed in (since, until]; for snapshots, every row. */
export function readDataset(
  deps: { db: Db; events: EventStore },
  ws: string,
  dataset: WarehouseDataset,
  since: string,
  until: string,
): AsyncGenerator<Row[]> {
  switch (dataset) {
    case 'profiles':
      return pgPages(
        deps.db,
        ws,
        sql`SELECT id, id AS profile_id, merged_into, traits, first_seen, last_seen, updated_at FROM profiles`,
        sql`updated_at > ${since} AND updated_at <= ${until}`,
        ['updated_at', 'id'],
      );
    case 'identifiers': {
      const w = sql.raw(DATASETS.identifiers.window!);
      return mapRows(
        pgPages(
          deps.db,
          ws,
          sql`SELECT type, value, profile_id, first_seen, warehouse_changed_at FROM identifiers`,
          sql`type IN ('user_id', 'anonymous_id') AND ${w} > ${since} AND ${w} <= ${until}`,
          [DATASETS.identifiers.window!, 'type', 'value'],
        ),
        ({ warehouse_changed_at: _changed, ...row }) => row,
      );
    }
    case 'consent': {
      const w = sql.raw(DATASETS.consent.window!);
      return mapRows(
        pgPages(
          deps.db,
          ws,
          sql`SELECT profile_id, purpose, channel, status, basis, updated_at, warehouse_changed_at FROM consent_state`,
          sql`${w} > ${since} AND ${w} <= ${until}`,
          [DATASETS.consent.window!, 'profile_id', 'purpose', 'channel'],
        ),
        ({ warehouse_changed_at: _changed, ...row }) => row,
      );
    }
    case 'segment_memberships':
      return pgPages(deps.db, ws, sql`SELECT segment_id, profile_id, since FROM segment_memberships`, sql`true`, [
        'segment_id',
        'profile_id',
      ]);
    case 'events':
      return mapRows(
        chBatches(
          deps.events,
          ws,
          `SELECT event_id, type, name, timestamp, received_at, anonymous_id, user_id,
                  toJSONString(properties) AS properties, toJSONString(context) AS context
           FROM events FINAL
           WHERE workspace_id = {ws:UUID} AND received_at > {since:DateTime64(3, 'UTC')} AND received_at <= {until:DateTime64(3, 'UTC')}
           ORDER BY received_at, event_id`,
          { since: chTime(since), until: chTime(until) },
        ),
        (r) => ({
          ...r,
          timestamp: toIso(r.timestamp),
          received_at: toIso(r.received_at),
          properties: JSON.parse(String(r.properties)),
          context: JSON.parse(String(r.context)),
        }),
      );
    case 'message_events':
      return mapRows(
        chBatches(
          deps.events,
          ws,
          `SELECT message_id, event_id, type, at, profile_id, channel, purpose, template_id, journey_id, reason, url
           FROM message_events FINAL
           WHERE workspace_id = {ws:UUID} AND at > {since:DateTime64(3, 'UTC')} AND at <= {until:DateTime64(3, 'UTC')}
           ORDER BY at, message_id, event_id`,
          { since: chTime(since), until: chTime(until) },
        ),
        (r) => ({ ...r, at: toIso(r.at) }),
      );
  }
}

async function* mapRows(source: AsyncGenerator<Row[]>, f: (r: Row) => Row): AsyncGenerator<Row[]> {
  for await (const rows of source) yield rows.map(f);
}

/** People erased in (since, until], so the warehouse can forget them too. */
export async function erasuresIn(db: Db, ws: string, since: string, until: string) {
  return db.withWorkspace(ws, async (tx) =>
    (
      await tx.execute<{ id: string; profile_ids: string[]; at: string | Date; warehouse_key_count: number | string }>(
        sql`SELECT id, profile_ids, at, warehouse_key_count FROM erasures WHERE at > ${since} AND at <= ${until} ORDER BY at`,
      )
    ).rows.map((r) => ({
      id: r.id,
      profileIds: r.profile_ids,
      at: new Date(r.at).toISOString(),
      keyCount: Number(r.warehouse_key_count),
    })),
  );
}

export interface ErasureIdentifier {
  type: 'anonymous_id' | 'user_id';
  value: string;
}

/** One erasure as a destination receives it. */
export interface Erasure {
  id: string;
  profileIds: string[];
  at: string;
  /**
   * The person's pseudonymous user and anonymous ids, captured when the profile was erased (#373).
   * A destination that never received the identifiers dataset still needs them to find events.
   */
  identifiers: ErasureIdentifier[];
  /** Datasets this erasure cannot cover, because its keys were not captured (see keyTrackingSince). */
  uncovered: WarehouseDataset[];
}

/**
 * Erasures started before this time have no captured keys: the identifier rows were already
 * deleted by the erasure that preceded the migration. For those, an events destination cannot
 * claim the person's events were removed.
 */
export async function keyTrackingSince(db: Db, ws: string): Promise<string> {
  const at = await db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ since: string | Date }>(sql`SELECT since FROM warehouse_erasure_key_tracking LIMIT 1`);
    return rows[0]?.since ?? null;
  });
  return at ? new Date(at).toISOString() : EPOCH;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Datasets an erasure cannot cover. Only events are located by identifier rather than profile id. */
export function uncoveredDatasets(input: {
  datasets: WarehouseDataset[];
  identifiers: ErasureIdentifier[];
  /** Keys captured for the erasure at the time it was recorded. */
  keyCount: number;
  erasedAt: string;
  trackingSince: string;
  destinationCreatedAt: string;
}): WarehouseDataset[] {
  const { datasets, identifiers, keyCount, erasedAt, trackingSince, destinationCreatedAt } = input;
  if (!datasets.includes('events') || identifiers.length) return [];
  // A destination created after the erasure never received that person's events: the source rows
  // were removed before it could export them. Only an older destination can hold them.
  if (Date.parse(erasedAt) < Date.parse(destinationCreatedAt)) return [];
  // Recorded by a version that did not capture keys: we cannot know whether events were exported.
  if (Date.parse(erasedAt) < Date.parse(trackingSince)) return ['events'];
  // It had event-capable ids when erased, but another destination already consumed and pruned
  // them: this one cannot locate the events it may hold. Zero keys means the person never had a
  // user or anonymous id, so no event can name them.
  return keyCount > 0 ? ['events'] : [];
}

/**
 * Attaches the captured user and anonymous ids to erasures, and marks those the destination
 * cannot fully apply. Keys are kept until every enabled destination has passed the erasure, so a
 * second destination still sees them.
 */
export async function erasuresForExport(
  db: Db,
  ws: string,
  since: string,
  until: string,
  datasets: WarehouseDataset[],
  destinationCreatedAt: string,
): Promise<Erasure[]> {
  const erasures = await erasuresIn(db, ws, since, until);
  if (!erasures.length) return [];
  const people = [...new Set(erasures.flatMap((e) => e.profileIds))];
  const [keys, trackingSince] = await Promise.all([
    db.withWorkspace(
      ws,
      async (tx) =>
        (
          await tx.execute<{ profile_id: string; type: ErasureIdentifier['type']; value: string }>(
            sql`SELECT profile_id, type, value FROM warehouse_erasure_keys
              WHERE workspace_id = ${ws} AND profile_id = ANY(${sql.param(people)}::text[])`,
          )
        ).rows,
    ),
    keyTrackingSince(db, ws),
  ]);
  const byProfile = new Map<string, ErasureIdentifier[]>();
  for (const k of keys) byProfile.set(k.profile_id, [...(byProfile.get(k.profile_id) ?? []), { type: k.type, value: k.value }]);
  return erasures.map((e) => {
    const identifiers = e.profileIds.flatMap((p) => byProfile.get(p) ?? []);
    const uncovered = uncoveredDatasets({
      datasets,
      identifiers,
      keyCount: e.keyCount,
      erasedAt: e.at,
      trackingSince,
      destinationCreatedAt,
    });
    return { id: e.id, profileIds: e.profileIds, at: e.at, identifiers, uncovered };
  });
}

/**
 * Drops captured keys once every enabled destination has exported the erasure that needed them.
 * With no enabled destination nothing will ever apply them, so they go too.
 */
export async function pruneErasureKeys(db: Db, ws: string): Promise<void> {
  await db.withWorkspace(ws, (tx) =>
    tx.execute(sql`
      DELETE FROM warehouse_erasure_keys k
      WHERE k.workspace_id = ${ws}
        AND NOT EXISTS (
          SELECT 1 FROM warehouse_exports w
          WHERE w.workspace_id = ${ws} AND w.enabled
            AND coalesce((w.cursors->>'erasures')::timestamptz, 'epoch'::timestamptz) < k.at
        )`),
  );
}
