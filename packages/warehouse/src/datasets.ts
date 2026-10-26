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
  },
  identifiers: {
    columns: { type: 'text', value: 'text', profile_id: 'text', first_seen: 'timestamptz' },
    key: ['type', 'value'],
    mode: 'incremental',
  },
  consent: {
    columns: { profile_id: 'text', purpose: 'text', channel: 'text', status: 'text', basis: 'text', updated_at: 'timestamptz' },
    key: ['profile_id', 'purpose', 'channel'],
    mode: 'incremental',
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
    case 'identifiers':
      return pgPages(
        deps.db,
        ws,
        sql`SELECT type, value, profile_id, first_seen FROM identifiers`,
        sql`type IN ('user_id', 'anonymous_id') AND first_seen > ${since} AND first_seen <= ${until}`,
        ['first_seen', 'type', 'value'],
      );
    case 'consent':
      return pgPages(
        deps.db,
        ws,
        sql`SELECT profile_id, purpose, channel, status, basis, updated_at FROM consent_state`,
        sql`updated_at > ${since} AND updated_at <= ${until}`,
        ['updated_at', 'profile_id', 'purpose', 'channel'],
      );
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
      await tx.execute<{ id: string; profile_ids: string[]; at: string | Date }>(
        sql`SELECT id, profile_ids, at FROM erasures WHERE at > ${since} AND at <= ${until} ORDER BY at`,
      )
    ).rows.map((r) => ({ id: r.id, profileIds: r.profile_ids, at: new Date(r.at).toISOString() })),
  );
}
