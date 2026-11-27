import { randomUUID } from 'node:crypto';
import type {} from '@agentic-marketing/commands';
import type { BusEvent } from '@agentic-marketing/events';
import Valkey from 'iovalkey';

// Hot state for the decision API (channels-and-personalization.md §3): the visitor's session and
// a snapshot of their profile, in Valkey, so `decide` never touches Postgres or ClickHouse.
// Everything here can be rebuilt: sessions expire, snapshots are rewritten on the next event.

export const SESSION_TTL_S = 30 * 60;
export const SNAPSHOT_TTL_S = 30 * 86_400;
// An erasure's fence must outlive every piece of hot state it replaces. Snapshots are the longest
// lived (30 days), so the tombstone keeps a further week: a write that was already in flight when the
// erasure ran can only land inside that window, and a reused anonymous id works again afterwards.
const TOMBSTONE_MARGIN_S = 7 * 86_400;
export const HOT_STATE_TOMBSTONE_TTL_S = SNAPSHOT_TTL_S + TOMBSTONE_MARGIN_S;

/**
 * Keys per `DEL`. A person with a large identifier family contributes two keys per anonymous id, and
 * `del(...keys)` with all of them exceeds V8's argument limit (about 125,000) before Valkey sees the
 * call. The erasure writes its tombstones before calling this, so splitting the delete can only leave
 * fenced (unreadable) snapshots behind, never an unfenced one.
 */
const DELETE_KEYS_PER_CALL = 1_000;

/** The hot-state subjects an erasure names. Profile ids are not keys today; they are fenced too. */
export interface HotStateIds {
  anonymousIds: string[];
  userIds: string[];
  profileIds?: string[];
}

/** The ids a snapshot write actually wrote; tombstoned subjects are absent. */
export interface WrittenHotStateIds {
  anonymousIds: string[];
  userIds: string[];
}

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

/** What a claim found: this call now owns a pending lease, or another call already holds/finished it. */
export type ClaimOutcome = { state: 'claimed'; token: string } | { state: 'pending' } | { state: 'done' };

export interface HotState {
  /** Counts accepted events into each visitor's session (ingest, before it answers). */
  recordSessions(events: BusEvent[]): Promise<void>;
  /**
   * Reads a session. A tombstoned anonymous id, or a tombstoned user id passed beside it, has no
   * session: `/v1/decide` passes both so an erased person cannot personalise through the other id.
   */
  session(workspaceId: string, anonymousId: string, userId?: string): Promise<Session>;
  /**
   * Writes a snapshot under every id. Atomic per call: a tombstoned subject is skipped, and the
   * result names the ids that were written (the edge mirror queues only those, #1196).
   */
  writeSnapshot(workspaceId: string, ids: HotStateIds, snapshot: ProfileSnapshot): Promise<WrittenHotStateIds>;
  deleteSnapshot(workspaceId: string, ids: HotStateIds): Promise<void>;
  /**
   * Fences these subjects against every later hot-state write (#1196). An erasure calls this before
   * it deletes the snapshot and session keys: a write that landed before the tombstone is deleted
   * by that delete, and a write after it is refused. The fence outlives the longest hot-state TTL
   * ({@link HOT_STATE_TOMBSTONE_TTL_S}); after it expires a reused id works normally again.
   */
  tombstone(workspaceId: string, ids: HotStateIds, ttlSeconds?: number): Promise<void>;
  /** Seconds until an anonymous id's tombstone expires; -2 absent, -1 no expiry. */
  tombstoneTtl(workspaceId: string, anonymousId: string): Promise<number>;
  /** Of these ids, the ones a tombstone fences (the edge mirror drops a queued snapshot for them). */
  tombstonedIds(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[] }): Promise<WrittenHotStateIds>;
  /** The snapshot for whichever id is known, user id first; a tombstoned subject has none. */
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
  /**
   * Claims a one-time key for `ttlSeconds` as pending. Returns the owner token when this call
   * created the pending lease, `done` when the key was already completed, or `pending` while
   * another request holds it. The token proves ownership to `complete` and `release`.
   */
  claim(key: string, ttlSeconds: number): Promise<ClaimOutcome>;
  /**
   * Marks a claimed key done for `ttlSeconds`, only while `token` still owns the pending lease.
   * False when the lease expired or another request took it over.
   */
  complete(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  /** Drops the pending lease when `token` still owns it (the publish failed). */
  release(key: string, token: string): Promise<void>;
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

// Pending → done must not overwrite a lease that expired and was taken by another request, so
// both transitions compare the owner token. Values are "p:<token>" while pending and "done" after.
const CLAIM = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], 'p:' .. ARGV[1], 'EX', ARGV[2])
  return 'claimed'
end
if string.sub(v, 1, 2) == 'p:' then return 'pending' end
return 'done'`;

const COMPLETE = `
local v = redis.call('GET', KEYS[1])
if v == 'p:' .. ARGV[1] then
  redis.call('SET', KEYS[1], 'done', 'EX', ARGV[2])
  return 1
end
return 0`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == 'p:' .. ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

// The erasure fence (#1196). Each target key sits next to its subject's tombstone key. One script
// decides and writes for the whole batch, so a check cannot be separated from its write by another
// client: every writer either finishes before the erasure sets the tombstone (and the erasure's
// later delete removes what it wrote) or sees the tombstone and writes nothing.
const WRITE_SNAPSHOT = `
local value, ttl = ARGV[1], tonumber(ARGV[2])
local accepted = {}
for i = 1, #KEYS, 2 do
  if redis.call('EXISTS', KEYS[i + 1]) == 0 then
    redis.call('SET', KEYS[i], value, 'EX', ttl)
    accepted[#accepted + 1] = (i + 1) / 2
  end
end
return accepted`;

// Session writes are per anonymous id: a subject's counters are applied in one script, gated on
// every id the event named. ARGV is the TTL, the group count, then one JSON object per group: the
// first timestamp, the field updates, and how many tombstone keys follow its session key. Each
// group is applied inside pcall, so a value Redis still rejects cannot abort every other visitor;
// a key this call created is dropped if its writes failed before EXPIRE.
const RECORD_SESSIONS = `
local ttl, groups = tonumber(ARGV[1]), tonumber(ARGV[2])
local written = 0
local k = 1
for g = 1, groups do
  local session = KEYS[k]
  k = k + 1
  local spec = cjson.decode(ARGV[g + 2])
  local blocked = false
  for j = 1, spec.tombs do
    if redis.call('EXISTS', KEYS[k]) == 1 then blocked = true end
    k = k + 1
  end
  if not blocked then
    local existed = redis.call('EXISTS', session) == 1
    local ok = pcall(function()
      if spec.first then redis.call('HSETNX', session, 'first', spec.first) end
      for _, op in ipairs(spec.ops) do
        if op[1] == 'incr' then redis.call('HINCRBY', session, op[2], op[3])
        elseif op[1] == 'set' then redis.call('HSET', session, op[2], op[3])
        else redis.call('HSETNX', session, op[2], op[3]) end
      end
    end)
    if ok then
      redis.call('EXPIRE', session, ttl)
      written = written + 1
    elseif existed then
      redis.call('EXPIRE', session, ttl)
    else
      -- Never leave a key this call created without a TTL.
      redis.call('DEL', session)
    end
  end
end
return written`;

type SessionWrite = { first?: string; ops: [op: 'incr' | 'set' | 'nx', field: string, value: string][]; tombs: number };

// Session values are the only part of a write a client controls. Keep them strings of a bounded
// length before they reach Lua: a boolean `page.path` used to abort the script after some writes
// and before EXPIRE, leaving the session with no TTL (#1196 review).
const SESSION_PATH_MAX = 2048;
const SESSION_FIRST_MAX = 64;
const SESSION_VALUE_MAX = 512;

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

export function valkeyHotState(opts: { url: string; prefix?: string }): HotState {
  const client = new Valkey(opts.url, { lazyConnect: true, maxRetriesPerRequest: 2, enableAutoPipelining: true });
  const p = opts.prefix ?? 'am';
  const sessionKey = (ws: string, anon: string) => `${p}:${ws}:s:${anon}`;
  const snapKey = (ws: string, kind: 'a' | 'u', id: string) => `${p}:${ws}:p:${kind}:${id}`;
  const tombKey = (ws: string, kind: 'a' | 'u' | 'p', id: string) => `${p}:${ws}:t:${kind}:${id}`;

  return {
    async recordSessions(events) {
      // One script per anonymous id, in one auto-pipelined batch. Events are aggregated the way the
      // old multi applied them: the first timestamp/ref/utm win, the last path wins, counts add up.
      type Group = {
        workspaceId: string;
        anonymousId: string;
        first?: string;
        counts: Map<string, number>;
        pageViews: number;
        path?: string;
        referrer?: string;
        utm?: string;
        tombs: Set<string>;
      };
      const groups = new Map<string, Group>();
      for (const e of events) {
        if (!e.anonymousId) continue;
        const k = `${e.workspaceId}\u0000${e.anonymousId}`;
        let g = groups.get(k);
        if (!g) {
          g = { workspaceId: e.workspaceId, anonymousId: e.anonymousId, counts: new Map(), pageViews: 0, tombs: new Set() };
          if (e.timestamp) g.first = boundedText(e.timestamp, SESSION_FIRST_MAX);
          groups.set(k, g);
        }
        const name = boundedText(e.name, SESSION_VALUE_MAX) ?? '';
        g.counts.set(`e:${name}`, (g.counts.get(`e:${name}`) ?? 0) + 1);
        if (e.type === 'page') {
          g.pageViews += 1;
          const page = (e.context?.page ?? {}) as { path?: unknown; referrer?: unknown; search?: unknown };
          const path = boundedText(page.path, SESSION_PATH_MAX);
          if (path) g.path = path;
          const referrer = boundedText(page.referrer, SESSION_PATH_MAX);
          if (!g.referrer && referrer) g.referrer = referrer;
          const search = boundedText(page.search, SESSION_PATH_MAX);
          const utm =
            (search ? new URLSearchParams(search).get('utm_source') : null) ??
            boundedText((e.context?.campaign as { source?: unknown } | undefined)?.source, SESSION_VALUE_MAX);
          if (!g.utm && utm) g.utm = utm;
        }
        // Every id the event names can fence the session, even when its anonymous id is new: the
        // cleanup tombstones user ids, and a late event with an erased user id must not rebuild a
        // session the erasure claimed (#1196 review).
        if (e.userId) g.tombs.add(tombKey(e.workspaceId, 'u', e.userId));
        if (e.profileId) g.tombs.add(tombKey(e.workspaceId, 'p', e.profileId));
      }
      if (!groups.size) return;
      const ordered = [...groups.values()];
      const keys: string[] = [];
      const specs: string[] = [];
      for (const g of ordered) {
        const ops: SessionWrite['ops'] = [];
        for (const [field, n] of g.counts) ops.push(['incr', field, String(n)]);
        if (g.pageViews) ops.push(['incr', 'pv', String(g.pageViews)]);
        if (g.path) ops.push(['set', 'path', g.path]);
        if (g.referrer) ops.push(['nx', 'ref', g.referrer]);
        if (g.utm) ops.push(['nx', 'utm', g.utm]);
        const tombs = [tombKey(g.workspaceId, 'a', g.anonymousId), ...g.tombs];
        keys.push(sessionKey(g.workspaceId, g.anonymousId), ...tombs);
        specs.push(JSON.stringify({ first: g.first, ops, tombs: tombs.length } satisfies SessionWrite));
      }
      await client.eval(RECORD_SESSIONS, keys.length, ...keys, SESSION_TTL_S, ordered.length, ...specs);
    },

    async session(ws, anon, userId) {
      // A tombstone makes the id stateless even if the erasure's delete has not run yet. The user
      // id is a second fence: an erased person's session may still exist under a new anonymous id.
      const tombs = [tombKey(ws, 'a', anon)];
      if (userId) tombs.push(tombKey(ws, 'u', userId));
      const [tomb, h] = await Promise.all([client.exists(...tombs), client.hgetall(sessionKey(ws, anon))]);
      const counts: Record<string, number> = {};
      if (!tomb) for (const [k, v] of Object.entries(h)) if (k.startsWith('e:')) counts[k.slice(2)] = Number(v);
      return {
        pageViews: tomb ? 0 : Number(h.pv ?? 0),
        firstSeen: tomb ? null : (h.first ?? null),
        lastPath: tomb ? null : (h.path ?? null),
        referrer: tomb ? null : (h.ref ?? null),
        utmSource: tomb ? null : (h.utm ?? null),
        counts,
        isNew: !!tomb || !h.first,
      };
    },

    async writeSnapshot(ws, ids, snap) {
      const entries: { kind: 'a' | 'u'; id: string }[] = [
        ...ids.anonymousIds.map((id) => ({ kind: 'a' as const, id })),
        ...ids.userIds.map((id) => ({ kind: 'u' as const, id })),
      ];
      const written: WrittenHotStateIds = { anonymousIds: [], userIds: [] };
      if (!entries.length) return written;
      const keys = entries.flatMap((e) => [snapKey(ws, e.kind, e.id), tombKey(ws, e.kind, e.id)]);
      const accepted = new Set((await client.eval(WRITE_SNAPSHOT, keys.length, ...keys, JSON.stringify(snap), SNAPSHOT_TTL_S)) as number[]);
      entries.forEach((e, i) => {
        if (accepted.has(i + 1)) (e.kind === 'a' ? written.anonymousIds : written.userIds).push(e.id);
      });
      return written;
    },

    async deleteSnapshot(ws, ids) {
      const keys = [
        ...ids.anonymousIds.flatMap((a) => [snapKey(ws, 'a', a), sessionKey(ws, a)]),
        ...ids.userIds.map((u) => snapKey(ws, 'u', u)),
      ];
      // The caller fences every id before this (#1196), so the delete may be split across calls: an
      // interrupted batch leaves a tombstoned snapshot that reads as absent anyway.
      for (let i = 0; i < keys.length; i += DELETE_KEYS_PER_CALL) await client.del(...keys.slice(i, i + DELETE_KEYS_PER_CALL));
    },

    async tombstone(ws, ids, ttlSeconds = HOT_STATE_TOMBSTONE_TTL_S) {
      const keys = [
        ...ids.anonymousIds.map((a) => tombKey(ws, 'a', a)),
        ...ids.userIds.map((u) => tombKey(ws, 'u', u)),
        ...(ids.profileIds ?? []).map((id) => tombKey(ws, 'p', id)),
      ];
      if (!keys.length) return;
      const multi = client.multi();
      for (const key of new Set(keys)) multi.set(key, '1', 'EX', ttlSeconds);
      const replies = await multi.exec();
      // A reply error (an invalid TTL, for example) would otherwise be discarded: the erasure would
      // delete and checkpoint without a fence (#1196 review). Throw so the cleanup retries.
      if (!replies) throw new Error('the hot-state tombstone transaction was not executed');
      for (const reply of replies) if (Array.isArray(reply) && reply[0]) throw reply[0];
    },

    async tombstoneTtl(ws, anon) {
      return client.ttl(tombKey(ws, 'a', anon));
    },

    async tombstonedIds(ws, ids) {
      const entries: { kind: 'a' | 'u'; id: string }[] = [
        ...ids.anonymousIds.map((id) => ({ kind: 'a' as const, id })),
        ...ids.userIds.map((id) => ({ kind: 'u' as const, id })),
      ];
      const hits = await Promise.all(entries.map((e) => client.exists(tombKey(ws, e.kind, e.id))));
      const fenced: WrittenHotStateIds = { anonymousIds: [], userIds: [] };
      entries.forEach((e, i) => {
        if (hits[i]) (e.kind === 'a' ? fenced.anonymousIds : fenced.userIds).push(e.id);
      });
      return fenced;
    },

    async snapshot(ws, ids) {
      const keys = [
        ...(ids.userId ? [{ key: snapKey(ws, 'u', ids.userId), tomb: tombKey(ws, 'u', ids.userId) }] : []),
        ...(ids.anonymousId ? [{ key: snapKey(ws, 'a', ids.anonymousId), tomb: tombKey(ws, 'a', ids.anonymousId) }] : []),
      ];
      if (!keys.length) return null;
      const [tombstoned, values] = await Promise.all([
        Promise.all(keys.map((k) => client.exists(k.tomb))),
        client.mget(...keys.map((k) => k.key)),
      ]);
      // Erasure fences every id of one person, so any fence hides the snapshot rather than exposing
      // the other id's copy.
      if (tombstoned.some(Boolean)) return null;
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

    async claim(key, ttlSeconds) {
      const token = randomUUID();
      const state = (await client.eval(CLAIM, 1, `${p}:once:${key}`, token, ttlSeconds)) as 'claimed' | 'pending' | 'done';
      return state === 'claimed' ? { state, token } : { state };
    },
    async complete(key, token, ttlSeconds) {
      return (await client.eval(COMPLETE, 1, `${p}:once:${key}`, token, ttlSeconds)) === 1;
    },
    async release(key, token) {
      await client.eval(RELEASE, 1, `${p}:once:${key}`, token);
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
