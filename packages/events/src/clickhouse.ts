import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type {} from '@agentic-marketing/commands';
import { type ClickHouseClient, createClient } from '@clickhouse/client';
import type { BusEvent } from './schema';

// ClickHouse is the event store. This module is the only place that talks to it, and every
// query it offers is scoped to one workspace (ClickHouse has no row-level security here).

const MIGRATIONS = new URL('../clickhouse/', import.meta.url);

export interface EventStore {
  insert(events: BusEvent[]): Promise<void>;
  /** Events of a person, by every anonymous id and user id they are known by. Newest first. */
  eventsOf(
    workspaceId: string,
    ids: { anonymousIds: string[]; userIds: string[] },
    opts?: { limit?: number; before?: string },
  ): Promise<StoredEvent[]>;
  /** Deletes a person's events (erasure). */
  deleteEventsOf(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[]; profileIds?: string[] }): Promise<void>;
  /** Matching events per identifier (segments): name, property equality, time window, optional id scope. */
  countEvents(
    workspaceId: string,
    q: {
      name: string;
      where?: Record<string, string | number | boolean>;
      sinceSeconds?: number;
      ids?: { anonymousIds: string[]; userIds: string[] };
      excludeEventIds?: string[];
    },
  ): Promise<{ anonymousId: string; userId: string; count: number }[]>;
  insertMessageEvents(events: MessageEvent[]): Promise<void>;
  messageEventsOf(workspaceId: string, filter: { messageIds?: string[]; profileId?: string }, limit?: number): Promise<MessageEvent[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  readonly client: ClickHouseClient;
}

export interface MessageEvent {
  workspaceId: string;
  messageId: string;
  /** Unique per event of a message (provider event id, or the decision). */
  eventId: string;
  type:
    | 'queued'
    | 'sent'
    | 'suppressed'
    | 'failed'
    | 'delivered'
    | 'bounced'
    | 'deferred'
    | 'complained'
    | 'opened'
    | 'clicked'
    | 'unsubscribed';
  at: string;
  profileId: string;
  channel: string;
  purpose: string;
  provider: string;
  templateId: string;
  templateVersion: number;
  journeyId: string;
  reason: string;
  url: string;
}

export interface StoredEvent {
  eventId: string;
  type: string;
  name: string;
  timestamp: string;
  receivedAt: string;
  anonymousId: string;
  userId: string;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
}

const toRow = (e: BusEvent) => ({
  workspace_id: e.workspaceId,
  event_id: e.messageId,
  source_id: e.sourceId,
  received_at: e.receivedAt.replace('Z', ''),
  timestamp: e.timestamp.replace('Z', ''),
  type: e.type,
  name: e.name,
  anonymous_id: e.anonymousId,
  user_id: e.userId,
  properties: e.properties,
  traits: e.traits,
  context: e.context,
  consent: e.consent,
});

/** Applies the SQL files in packages/events/clickhouse once each, in order. */
export async function migrateClickHouse(url: string, database: string, log: (m: string) => void = () => {}) {
  const root = createClient({ url });
  await root.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  await root.close();
  const ch = createClient({ url, database });
  await ch.command({
    query:
      'CREATE TABLE IF NOT EXISTS schema_migrations (name String, checksum String, at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY name',
  });
  const applied = new Map(
    (
      await (
        await ch.query({ query: 'SELECT name, checksum FROM schema_migrations', format: 'JSONEachRow' })
      ).json<{ name: string; checksum: string }>()
    ).map((r) => [r.name, r.checksum]),
  );
  for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum)
        throw new Error(`ClickHouse migration ${file} was changed after it was applied. Add a new file instead.`);
      continue;
    }
    for (const statement of sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean))
      await ch.command({ query: statement });
    await ch.insert({ table: 'schema_migrations', values: [{ name: file, checksum }], format: 'JSONEachRow' });
    log(`applied ClickHouse migration ${file}`);
  }
  await ch.close();
}

export function clickHouseStore(opts: { url: string; database: string }): EventStore {
  const client = createClient({
    url: opts.url,
    database: opts.database,
    clickhouse_settings: { date_time_input_format: 'best_effort', output_format_json_quote_64bit_integers: 0 },
  });
  const idFilter = 'workspace_id = {ws:UUID} AND (anonymous_id IN {anon:Array(String)} OR user_id IN {users:Array(String)})';
  const params = (workspaceId: string, ids: { anonymousIds: string[]; userIds: string[] }) => ({
    ws: workspaceId,
    anon: ids.anonymousIds,
    users: ids.userIds,
  });
  return {
    client,
    async insert(events) {
      if (events.length) await client.insert({ table: 'events', values: events.map(toRow), format: 'JSONEachRow' });
    },
    async eventsOf(workspaceId, ids, o = {}) {
      if (!ids.anonymousIds.length && !ids.userIds.length) return [];
      const rs = await client.query({
        query: `SELECT event_id, type, name, timestamp, received_at, anonymous_id, user_id, properties, context
                FROM events FINAL
                WHERE ${idFilter} ${o.before ? 'AND timestamp < {before:DateTime64(3)}' : ''}
                ORDER BY timestamp DESC LIMIT {limit:UInt32}`,
        query_params: { ...params(workspaceId, ids), limit: o.limit ?? 100, before: o.before?.replace('Z', '') },
        format: 'JSONEachRow',
      });
      const rows = await rs.json<Record<string, never>>();
      return rows.map((r) => ({
        eventId: r.event_id,
        type: r.type,
        name: r.name,
        timestamp: `${String(r.timestamp).replace(' ', 'T')}Z`,
        receivedAt: `${String(r.received_at).replace(' ', 'T')}Z`,
        anonymousId: r.anonymous_id,
        userId: r.user_id,
        properties: r.properties,
        context: r.context,
      }));
    },
    async deleteEventsOf(workspaceId, ids) {
      if (ids.profileIds?.length)
        await client.command({
          query: 'DELETE FROM message_events WHERE workspace_id = {ws:UUID} AND profile_id IN {profiles:Array(String)}',
          query_params: { ws: workspaceId, profiles: ids.profileIds },
        });
      if (!ids.anonymousIds.length && !ids.userIds.length) return;
      // Lightweight delete: rows disappear from queries at once and from disk on the next merge.
      await client.command({ query: `DELETE FROM events WHERE ${idFilter}`, query_params: params(workspaceId, ids) });
    },
    async countEvents(workspaceId, q) {
      const params: Record<string, unknown> = { ws: workspaceId, name: q.name, exclude: q.excludeEventIds ?? [] };
      const where = Object.entries(q.where ?? {}).map(([k, v], i) => {
        // Keys are validated as [A-Za-z0-9_]; values travel as parameters.
        if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) throw new Error(`invalid property name ${k}`);
        params[`v${i}`] = String(v);
        return `toString(properties.\`${k}\`) = {v${i}:String}`;
      });
      if (q.sinceSeconds) params.since = q.sinceSeconds;
      if (q.ids) Object.assign(params, { anon: q.ids.anonymousIds, users: q.ids.userIds });
      const rs = await client.query({
        query: `SELECT anonymous_id, user_id, count() AS c FROM events FINAL
                WHERE workspace_id = {ws:UUID} AND name = {name:String}
                ${q.sinceSeconds ? 'AND timestamp >= now64(3) - toIntervalSecond({since:UInt32})' : ''}
                ${q.ids ? 'AND (anonymous_id IN {anon:Array(String)} OR user_id IN {users:Array(String)})' : ''}
                ${q.excludeEventIds?.length ? 'AND event_id NOT IN {exclude:Array(String)}' : ''}
                ${where.map((w) => `AND ${w}`).join(' ')}
                GROUP BY anonymous_id, user_id`,
        query_params: params,
        format: 'JSONEachRow',
      });
      return (await rs.json<{ anonymous_id: string; user_id: string; c: number }>()).map((r) => ({
        anonymousId: r.anonymous_id,
        userId: r.user_id,
        count: Number(r.c),
      }));
    },
    async insertMessageEvents(events) {
      if (!events.length) return;
      await client.insert({
        table: 'message_events',
        format: 'JSONEachRow',
        values: events.map((e) => ({
          workspace_id: e.workspaceId,
          message_id: e.messageId,
          event_id: e.eventId,
          type: e.type,
          at: e.at.replace('Z', ''),
          profile_id: e.profileId,
          channel: e.channel,
          purpose: e.purpose,
          provider: e.provider,
          template_id: e.templateId,
          template_version: e.templateVersion,
          journey_id: e.journeyId,
          reason: e.reason,
          url: e.url,
        })),
      });
    },
    async messageEventsOf(workspaceId, filter, limit = 200) {
      const rs = await client.query({
        query: `SELECT * FROM message_events FINAL WHERE workspace_id = {ws:UUID}
                ${filter.messageIds ? 'AND message_id IN {ids:Array(String)}' : ''}
                ${filter.profileId ? 'AND profile_id = {profile:String}' : ''}
                ORDER BY at DESC LIMIT {limit:UInt32}`,
        query_params: { ws: workspaceId, ids: filter.messageIds ?? [], profile: filter.profileId ?? '', limit },
        format: 'JSONEachRow',
      });
      return (await rs.json<Record<string, never>>()).map((r) => ({
        workspaceId: r.workspace_id,
        messageId: r.message_id,
        eventId: r.event_id,
        type: r.type,
        at: `${String(r.at).replace(' ', 'T')}Z`,
        profileId: r.profile_id,
        channel: r.channel,
        purpose: r.purpose,
        provider: r.provider,
        templateId: r.template_id,
        templateVersion: r.template_version,
        journeyId: r.journey_id,
        reason: r.reason,
        url: r.url,
      }));
    },
    async ping() {
      return (await client.ping()).success;
    },
    async close() {
      await client.close();
    },
  };
}

declare module '@agentic-marketing/commands' {
  interface Services {
    events: EventStore;
    bus: import('./bus').EventBus;
  }
}

/** Drops a ClickHouse database (tests, and resetting a development install). */
export async function resetClickHouse(url: string, database: string) {
  const root = createClient({ url });
  await root.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  await root.close();
}
