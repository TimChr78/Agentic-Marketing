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
  /** Per variant: visitors exposed to an experience, and how many did the goal event after their first exposure. */
  experimentCounts(
    workspaceId: string,
    q: { experienceId: string; goal?: string; since?: Date },
  ): Promise<{ variant: string; exposed: number; converted: number }[]>;
  insertMessageEvents(events: MessageEvent[]): Promise<void>;
  insertJourneyEvents(events: JourneyEvent[]): Promise<void>;
  /** Unique messages per event type since a time, optionally for one template or journey. */
  messageStats(workspaceId: string, q: { since: Date; templateId?: string; journeyId?: string }): Promise<Record<string, number>>;
  /** Per node and event type counts for a journey (analytics, canvas overlays). */
  journeyCounts(workspaceId: string, journeyId: string): Promise<{ node: string; type: string; count: number }[]>;
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

export interface JourneyEvent {
  workspaceId: string;
  journeyId: string;
  version: number;
  participantId: number;
  profileId: string;
  node: string;
  type: 'entered' | 'step' | 'waiting' | 'resumed' | 'converted' | 'completed' | 'exited' | 'failed';
  seq: number;
  at: string;
  detail: string;
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
        for (const table of ['message_events', 'journey_events'])
          await client.command({
            query: `DELETE FROM ${table} WHERE workspace_id = {ws:UUID} AND profile_id IN {profiles:Array(String)}`,
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
    async experimentCounts(workspaceId, q) {
      const rs = await client.query({
        query: `WITH
            exposures AS (
              SELECT anonymous_id AS visitor, argMin(toString(properties.variant_id), timestamp) AS variant, min(timestamp) AS first
              FROM events FINAL
              WHERE workspace_id = {ws:UUID} AND name = 'Experience Viewed' AND toString(properties.experience_id) = {exp:String}
                AND anonymous_id != '' AND timestamp >= {since:DateTime64(3)}
              GROUP BY anonymous_id),
            goals AS (
              SELECT anonymous_id AS visitor, max(timestamp) AS last
              FROM events FINAL
              WHERE workspace_id = {ws:UUID} AND name = {goal:String} AND anonymous_id != '' AND timestamp >= {since:DateTime64(3)}
              GROUP BY anonymous_id)
          SELECT e.variant AS variant, count() AS exposed, countIf(g.visitor != '' AND g.last >= e.first) AS converted
          FROM exposures e LEFT JOIN goals g ON g.visitor = e.visitor
          GROUP BY e.variant ORDER BY e.variant`,
        query_params: {
          ws: workspaceId,
          exp: q.experienceId,
          goal: q.goal ?? '',
          since: (q.since ?? new Date(0)).toISOString().replace('Z', ''),
        },
        format: 'JSONEachRow',
        clickhouse_settings: { join_use_nulls: 0 },
      });
      return (await rs.json<{ variant: string; exposed: number; converted: number }>()).map((r) => ({
        variant: r.variant,
        exposed: Number(r.exposed),
        converted: Number(r.converted),
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
    async insertJourneyEvents(events) {
      if (!events.length) return;
      await client.insert({
        table: 'journey_events',
        format: 'JSONEachRow',
        values: events.map((e) => ({
          workspace_id: e.workspaceId,
          journey_id: e.journeyId,
          version: e.version,
          participant_id: e.participantId,
          profile_id: e.profileId,
          node: e.node,
          type: e.type,
          seq: e.seq,
          at: e.at.replace('Z', ''),
          detail: e.detail,
        })),
      });
    },
    async messageStats(workspaceId, q) {
      const rs = await client.query({
        query: `SELECT type, uniqExact(message_id) AS c FROM message_events FINAL
                WHERE workspace_id = {ws:UUID} AND at >= {since:DateTime64(3)}
                ${q.templateId ? 'AND template_id = {t:String}' : ''} ${q.journeyId ? 'AND journey_id = {j:String}' : ''}
                GROUP BY type`,
        query_params: { ws: workspaceId, since: q.since.toISOString().replace('Z', ''), t: q.templateId ?? '', j: q.journeyId ?? '' },
        format: 'JSONEachRow',
      });
      return Object.fromEntries((await rs.json<{ type: string; c: number }>()).map((r) => [r.type, Number(r.c)]));
    },
    async journeyCounts(workspaceId, journeyId) {
      const rs = await client.query({
        query: `SELECT node, type, uniqExact(participant_id) AS c FROM journey_events FINAL
                WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} GROUP BY node, type`,
        query_params: { ws: workspaceId, j: journeyId },
        format: 'JSONEachRow',
      });
      return (await rs.json<{ node: string; type: string; c: number }>()).map((r) => ({ node: r.node, type: r.type, count: Number(r.c) }));
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
