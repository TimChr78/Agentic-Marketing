import type {} from '@agentic-marketing/commands';
import type { BusEvent } from '@agentic-marketing/events';
import Valkey from 'iovalkey';

// Hot state for the decision API (channels-and-personalization.md §3): the visitor's session and
// a snapshot of their profile, in Valkey, so `decide` never touches Postgres or ClickHouse.
// Everything here can be rebuilt: sessions expire, snapshots are rewritten on the next event.

const SESSION_TTL_S = 30 * 60;
const SNAPSHOT_TTL_S = 30 * 86_400;

export interface Session {
  pageViews: number;
  firstSeen: string | null;
  lastPath: string | null;
  referrer: string | null;
  utmSource: string | null;
  /** Events of this session by name. */
  counts: Record<string, number>;
  isNew: boolean;
}

export interface ProfileSnapshot {
  profileId: string;
  /** Non-personal traits only. */
  traits: Record<string, unknown>;
  segments: string[];
  at: string;
}

export interface HotState {
  /** Counts accepted events into each visitor's session (ingest, before it answers). */
  recordSessions(events: BusEvent[]): Promise<void>;
  session(workspaceId: string, anonymousId: string): Promise<Session>;
  writeSnapshot(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[] }, snapshot: ProfileSnapshot): Promise<void>;
  deleteSnapshot(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[] }): Promise<void>;
  /** The snapshot for whichever id is known, user id first. */
  snapshot(workspaceId: string, ids: { anonymousId?: string; userId?: string }): Promise<ProfileSnapshot | null>;
  /**
   * Takes `n` tokens from a bucket shared by every process (sustained `rate` per second, bursts up
   * to `burst`). False when there are not enough; then nothing is taken.
   */
  take(key: string, n: number, rate: number, burst: number): Promise<boolean>;
  /** A version stamp shared by all processes: `bump` changes it, `stamp` reads it (cache invalidation). */
  bump(key: string): Promise<void>;
  stamp(key: string): Promise<string>;
  /** A short-lived string shared by all processes (e.g. a link-check result); null when absent. */
  cached(key: string): Promise<string | null>;
  cache(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** When `key` is locked out after repeated failures, or null. */
  failureLock(key: string): Promise<Date | null>;
  /**
   * Counts a failure in a window shared by all processes. Once `limit` failures happen inside
   * `windowSeconds`, further attempts are refused until `blockSeconds` has passed.
   */
  recordFailure(key: string, limit: number, windowSeconds: number, blockSeconds: number): Promise<Date | null>;
  /** Forgets earlier failures, e.g. after a correct password. */
  clearFailures(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

// Token bucket in one atomic step, timed by the server's clock so processes need not agree.
const TAKE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local rate, burst, n = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 't', 'a')
local tokens = tonumber(b[1]) or burst
local at = tonumber(b[2]) or now
tokens = math.min(burst, tokens + (now - at) / 1000 * rate)
local ok = 0
if tokens >= n then tokens = tokens - n; ok = 1 end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'a', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return ok`;

// Failure counters for step-up checks (#61). The window and the lockout are explicit so the
// caller can say when to retry. Expiry is set from the server clock, not the client's.
const FAILURE_STATE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local b = redis.call('HMGET', KEYS[1], 'c', 'b')
local count = tonumber(b[1]) or 0
local blockedUntil = tonumber(b[2]) or 0
if blockedUntil > 0 and blockedUntil <= now then
  redis.call('DEL', KEYS[1])
  return {0, 0}
end
if blockedUntil > now then return {count, blockedUntil} end
return {count, 0}`;

const RECORD_FAILURE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit, windowMs, blockMs = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 'c', 'w', 'b')
local count = tonumber(b[1]) or 0
local windowStart = tonumber(b[2]) or 0
local blockedUntil = tonumber(b[3]) or 0
if blockedUntil > now then return {count, blockedUntil} end
if blockedUntil > 0 then count, windowStart, blockedUntil = 0, 0, 0 end
if windowStart == 0 or now - windowStart >= windowMs then count, windowStart = 0, now end
count = count + 1
local lock = 0
if count >= limit then lock = now + blockMs end
redis.call('HSET', KEYS[1], 'c', tostring(count), 'w', tostring(windowStart), 'b', tostring(lock))
redis.call('PEXPIRE', KEYS[1], windowMs + blockMs + 1000)
return {count, lock}`;

export function valkeyHotState(opts: { url: string; prefix?: string }): HotState {
  const client = new Valkey(opts.url, { lazyConnect: true, maxRetriesPerRequest: 2, enableAutoPipelining: true });
  const p = opts.prefix ?? 'am';
  const sessionKey = (ws: string, anon: string) => `${p}:${ws}:s:${anon}`;
  const snapKey = (ws: string, kind: 'a' | 'u', id: string) => `${p}:${ws}:p:${kind}:${id}`;

  return {
    async recordSessions(events) {
      const multi = client.multi();
      let n = 0;
      for (const e of events) {
        if (!e.anonymousId) continue;
        const k = sessionKey(e.workspaceId, e.anonymousId);
        multi.hsetnx(k, 'first', e.timestamp);
        multi.hincrby(k, `e:${e.name}`, 1);
        if (e.type === 'page') {
          multi.hincrby(k, 'pv', 1);
          const page = (e.context.page ?? {}) as { path?: string; referrer?: string; search?: string };
          if (page.path) multi.hset(k, 'path', page.path);
          if (page.referrer) multi.hsetnx(k, 'ref', page.referrer);
          const utm =
            new URLSearchParams(page.search ?? '').get('utm_source') ??
            (e.context.campaign as { source?: string } | undefined)?.source ??
            null;
          if (utm) multi.hsetnx(k, 'utm', utm);
        }
        multi.expire(k, SESSION_TTL_S);
        n++;
      }
      if (n) await multi.exec();
    },

    async session(ws, anon) {
      const h = await client.hgetall(sessionKey(ws, anon));
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(h)) if (k.startsWith('e:')) counts[k.slice(2)] = Number(v);
      return {
        pageViews: Number(h.pv ?? 0),
        firstSeen: h.first ?? null,
        lastPath: h.path ?? null,
        referrer: h.ref ?? null,
        utmSource: h.utm ?? null,
        counts,
        isNew: !h.first,
      };
    },

    async writeSnapshot(ws, ids, snap) {
      const value = JSON.stringify(snap);
      const multi = client.multi();
      for (const a of ids.anonymousIds) multi.set(snapKey(ws, 'a', a), value, 'EX', SNAPSHOT_TTL_S);
      for (const u of ids.userIds) multi.set(snapKey(ws, 'u', u), value, 'EX', SNAPSHOT_TTL_S);
      await multi.exec();
    },

    async deleteSnapshot(ws, ids) {
      const keys = [
        ...ids.anonymousIds.flatMap((a) => [snapKey(ws, 'a', a), sessionKey(ws, a)]),
        ...ids.userIds.map((u) => snapKey(ws, 'u', u)),
      ];
      if (keys.length) await client.del(...keys);
    },

    async snapshot(ws, ids) {
      const keys = [ids.userId && snapKey(ws, 'u', ids.userId), ids.anonymousId && snapKey(ws, 'a', ids.anonymousId)].filter(
        (k): k is string => !!k,
      );
      if (!keys.length) return null;
      const values = await client.mget(...keys);
      const hit = values.find((v) => v);
      return hit ? (JSON.parse(hit) as ProfileSnapshot) : null;
    },

    async bump(key) {
      await client.incr(`${p}:v:${key}`);
    },
    async stamp(key) {
      return (await client.get(`${p}:v:${key}`)) ?? '0';
    },

    async cached(key) {
      return client.get(`${p}:c:${key}`);
    },
    async cache(key, value, ttlSeconds) {
      await client.set(`${p}:c:${key}`, value, 'EX', ttlSeconds);
    },

    async take(key, n, rate, burst) {
      return (await client.eval(TAKE, 1, `${p}:rl:${key}`, rate, burst, n)) === 1;
    },

    async failureLock(key) {
      const [, blockedUntil] = (await client.eval(FAILURE_STATE, 1, `${p}:fail:${key}`)) as [number, number];
      return Number(blockedUntil) > 0 ? new Date(Number(blockedUntil)) : null;
    },

    async recordFailure(key, limit, windowSeconds, blockSeconds) {
      const [, blockedUntil] = (await client.eval(
        RECORD_FAILURE,
        1,
        `${p}:fail:${key}`,
        limit,
        windowSeconds * 1000,
        blockSeconds * 1000,
      )) as [number, number];
      return Number(blockedUntil) > 0 ? new Date(Number(blockedUntil)) : null;
    },

    async clearFailures(key) {
      await client.del(`${p}:fail:${key}`);
    },

    async ping() {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },

    async close() {
      client.disconnect();
    },
  };
}

declare module '@agentic-marketing/commands' {
  interface Services {
    hot: HotState;
  }
}
