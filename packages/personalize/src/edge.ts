import { setTimeout as delay } from 'node:timers/promises';
import { artifactTypes, DEFAULT_PURPOSES, publishedSingleton, publishListeners } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, sha256 } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { HotState, ProfileSnapshot } from '@agentic-marketing/hotstate';
import { type EgressPolicy, egressFetch } from '@agentic-marketing/integrations';
import { type KeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EdgeSource, PublishedExperience } from './core';
import { refreshSnapshots } from './snapshots';

// Decisions at the edge: the decision API's inputs mirrored to Cloudflare Workers KV, where the
// edge worker (packages/edge-worker) answers /v1/decide in the visitor's region.
//
//   am:key:<write key hash>   the source (workspace, kind, consent purpose, origins)
//   am:exp:<workspace>        published experiences and purposes, pushed when they change
//   am:snap:<workspace>:a|u:<id>  profile snapshots (non-personal traits, segments), 30 days
//
// Snapshot writes and deletions (erasure) queue in edge_outbox and go up in bulk every second.
// What KV may not hold: sessions (page views, events this visit). Session conditions are false at
// the edge; the server keeps answering them.

export const KV_SNAPSHOT_TTL_S = 30 * 86_400;
export const kvKeys = {
  source: (keyHash: string) => `am:key:${keyHash}`,
  bundle: (ws: string) => `am:exp:${ws}`,
  snapshot: (ws: string, kind: 'a' | 'u', id: string) => `am:snap:${ws}:${kind}:${id}`,
};

/** The prefix every snapshot of a workspace shares, so a cleanup can find the ones it can no longer derive. */
export const snapshotPrefix = (ws: string) => `am:snap:${ws}:`;

/** What remains to remove from KV after serving was turned off: people (snapshots) or everything. */
export type EdgeCleanupMode = 'snapshots' | 'all';

/**
 * A destination we stopped using. Its keys cannot be derived from the current target, so the
 * identity and the keys we pushed are kept until a deletion with the current token succeeds.
 */
export interface PriorEdgeTarget {
  accountId: string;
  namespaceId: string;
  apiBase: string | null;
  keys: string[];
  /** Failed attempts back off instead of calling a namespace the current token cannot reach every second. */
  nextAttemptAt?: string;
  lastError?: string;
}

/** What the worker reads per workspace. */
export interface EdgeBundle {
  experiences: PublishedExperience[];
  purposes: { key: string; basis: string }[];
}

export async function loadPublishedExperiences(tx: Tx): Promise<PublishedExperience[]> {
  const rows = await tx
    .select({
      id: schema.artifacts.id,
      version: schema.artifacts.publishedVersion,
      content: schema.artifactVersions.content,
      share: schema.experienceRollouts.share,
    })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .leftJoin(
      schema.experienceRollouts,
      and(
        eq(schema.experienceRollouts.workspaceId, schema.artifacts.workspaceId),
        eq(schema.experienceRollouts.artifactId, schema.artifacts.id),
        eq(schema.experienceRollouts.version, schema.artifacts.publishedVersion),
      ),
    )
    .where(
      and(eq(schema.artifacts.type, 'experience'), isNotNull(schema.artifacts.publishedVersion), eq(schema.artifacts.archived, false)),
    );
  return rows
    .map((r) => ({
      id: r.id,
      version: r.version ?? 0,
      def: artifactTypes.experience.content.parse(r.content),
      share: r.share ?? null,
    }))
    .sort((a, b) => b.def.priority - a.def.priority);
}

// ---------- Settings ----------

const Status = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  accountId: z.string().nullable(),
  namespaceId: z.string().nullable(),
  snapshots: z.boolean(),
  hasToken: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  queuedSnapshots: z.number().int(),
  backfilling: z.boolean(),
  /** Remote cleanup still owed after serving was turned off (null when there is none). */
  cleanup: z.enum(['snapshots', 'all']).nullable(),
  /** Queued deletions not yet delivered to KV; they survive a failed sync. */
  pendingDeletes: z.number().int(),
  /** Earlier destinations whose copies could not be removed yet (e.g. a token for another account). */
  staleTargets: z.array(
    z.object({
      accountId: z.string(),
      namespaceId: z.string(),
      apiBase: z.string().nullable(),
      lastError: z.string().nullable(),
      nextAttemptAt: z.string().nullable(),
    }),
  ),
});

async function status(tx: Tx): Promise<z.infer<typeof Status>> {
  const [t] = await tx.select().from(schema.edgeTargets);
  const [q] = (
    await tx.execute<{ n: number; d: number }>(
      sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE value IS NULL)::int AS d FROM edge_outbox`,
    )
  ).rows;
  return {
    configured: !!t,
    enabled: t?.enabled ?? false,
    accountId: t?.accountId ?? null,
    namespaceId: t?.namespaceId ?? null,
    snapshots: t?.snapshots ?? true,
    hasToken: !!t?.secrets,
    lastSyncAt: t?.lastSyncAt?.toISOString() ?? null,
    lastError: t?.lastError ?? null,
    queuedSnapshots: q?.n ?? 0,
    backfilling: t?.backfillCursor != null,
    cleanup: t?.cleanupMode ?? null,
    pendingDeletes: q?.d ?? 0,
    staleTargets: (t?.priorTarget ?? []).map((p) => ({
      accountId: p.accountId,
      namespaceId: p.namespaceId,
      apiBase: p.apiBase ?? null,
      lastError: p.lastError ?? null,
      nextAttemptAt: p.nextAttemptAt ?? null,
    })),
  };
}

export interface EdgeSettings {
  accountId: string;
  namespaceId: string;
  apiBase: string | null;
  snapshots: boolean;
  enabled: boolean;
  bundleHash: string | null;
  pushedKeys: string[];
  backfillCursor: string | null;
  cleanupMode: EdgeCleanupMode | null;
  priorTarget: PriorEdgeTarget[] | null;
}

export interface EdgeConfigureInput {
  accountId: string;
  namespaceId: string;
  apiBase?: string;
  snapshots?: boolean;
  enabled?: boolean;
}

const destination = (t: { accountId: string; namespaceId: string; apiBase?: string | null }) =>
  `${t.accountId}/${t.namespaceId}/${t.apiBase ?? ''}`;

/**
 * The target row after `edge.configure`. Enabling a destination that never served (or re-enabling
 * one) starts a backfill; a new account, namespace or API base restarts it and queues removal of
 * the copies in the old namespace. Rotating only the token leaves the backfill and bundle alone.
 * Turning serving off never clears the cleanup: the next sync removes the remote copies first.
 */
export function planEdgeConfigure(prev: EdgeSettings | null, input: EdgeConfigureInput) {
  const next = {
    accountId: input.accountId,
    namespaceId: input.namespaceId,
    apiBase: input.apiBase ?? prev?.apiBase ?? null,
    snapshots: input.snapshots ?? prev?.snapshots ?? true,
    enabled: input.enabled ?? prev?.enabled ?? true,
  };
  if (!prev) {
    return {
      ...next,
      bundleHash: null,
      pushedKeys: [] as string[],
      backfillCursor: next.enabled && next.snapshots ? '' : null,
      cleanupMode: null as EdgeCleanupMode | null,
      priorTarget: null as PriorEdgeTarget[] | null,
    };
  }
  const moved = destination(prev) !== destination(next);
  // Deduplicate earlier destinations; one we are about to reuse is cleaned by cleanupMode below.
  let priorTarget = prev.priorTarget ?? [];
  if (moved) {
    const merged = new Map<string, PriorEdgeTarget>();
    for (const p of [
      ...priorTarget,
      { accountId: prev.accountId, namespaceId: prev.namespaceId, apiBase: prev.apiBase ?? null, keys: [...prev.pushedKeys] },
    ]) {
      const previous = merged.get(destination(p));
      merged.set(destination(p), { ...p, keys: [...new Set([...(previous?.keys ?? []), ...p.keys])] });
    }
    priorTarget = [...merged.values()];
  }
  const reusedKeys = priorTarget.find((p) => destination(p) === destination(next))?.keys ?? [];
  priorTarget = priorTarget.filter((p) => destination(p) !== destination(next));
  const startsBackfill = moved || (next.enabled && !prev.enabled) || (next.snapshots && !prev.snapshots);
  const servesSnapshots = next.enabled && next.snapshots;
  let cleanupMode = prev.cleanupMode;
  if (!next.enabled) {
    // Removing the bundle and write keys is what revokes the edge endpoint; it does not wait for
    // the next configure, and a failure leaves this set so the sync retries.
    if (prev.enabled) cleanupMode = 'all';
  } else if (!next.snapshots) {
    if (prev.snapshots) cleanupMode = prev.cleanupMode === 'all' ? 'all' : 'snapshots';
  }
  // A new (or reused) namespace may hold copies from an earlier configuration: clear it before
  // the first bundle write. Re-enabling also pushes the bundle again (the cleanup deleted it).
  if (moved) cleanupMode = 'all';
  return {
    ...next,
    bundleHash: moved || (next.enabled && !prev.enabled) ? null : prev.bundleHash,
    pushedKeys: moved ? [...reusedKeys] : prev.pushedKeys,
    backfillCursor: !servesSnapshots ? null : startsBackfill ? '' : prev.backfillCursor,
    cleanupMode,
    priorTarget: priorTarget.length ? priorTarget : null,
  };
}

export const edgeStatus = defineCommand({
  name: 'edge.status',
  title: 'Edge decisions status',
  description:
    'Whether experiences and profile snapshots are mirrored to Cloudflare Workers KV for the edge worker, and how the last sync went.',
  input: z.object({}),
  output: Status,
  permission: 'workspace:admin',
  effect: 'read',
  handler: (_i, ctx) => status(ctx.tx),
});

export const edgeConfigure = defineCommand({
  name: 'edge.configure',
  title: 'Configure edge decisions',
  description:
    'Mirror the decision API to Cloudflare Workers KV: the account and KV namespace the edge worker is bound to, and an API token with "Workers KV Storage: Edit". With snapshots off, only page, referrer, UTM and device targeting work at the edge (fewer KV writes).',
  input: z.object({
    accountId: z.string().regex(/^[0-9a-f]{32}$/),
    namespaceId: z.string().regex(/^[0-9a-f]{32}$/),
    apiToken: z.string().min(20).max(200).optional(),
    snapshots: z.boolean().optional(),
    enabled: z.boolean().optional(),
    apiBase: z.url().optional().describe('Another Cloudflare API base, e.g. a test server'),
  }),
  output: Status,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['apiToken'],
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-config:${ws}`}, 0))`);
    const sealed = input.apiToken ? await sealJson(ctx.tx, ws, ctx.services.keyProvider, { apiToken: input.apiToken }) : null;
    const [prev] = await ctx.tx.select().from(schema.edgeTargets).for('update');
    const plan = planEdgeConfigure(prev ?? null, input);
    const values = {
      ...plan,
      ...(sealed ? { secrets: sealed.blob, secretsKeyId: sealed.keyId } : {}),
      updatedAt: new Date(),
    };
    await ctx.tx
      .insert(schema.edgeTargets)
      .values({ workspaceId: ws, ...values })
      .onConflictDoUpdate({
        target: schema.edgeTargets.workspaceId,
        set: { ...values, generation: sql`${schema.edgeTargets.generation} + 1` },
      });
    ctx.afterCommit?.(async () => {
      mirrorOn.delete(ws);
    });
    const s = await status(ctx.tx);
    if (!s.hasToken) throw new AppError('invalid_input', 'Give the Cloudflare API token (apiToken) the first time.');
    return s;
  },
});

export const edgeSync = defineCommand({
  name: 'edge.sync',
  title: 'Sync the edge now',
  description:
    'Push experiences and write keys to KV at the next sync (within seconds). With backfillSnapshots, also write the snapshots of everyone, not only of people active since edge decisions were turned on.',
  input: z.object({ backfillSnapshots: z.boolean().default(false) }),
  output: Status,
  permission: 'workspace:admin',
  effect: 'write',
  actionClass: 'experience.live',
  handler: async (input, ctx) => {
    await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-config:${ctx.principal.workspaceId}`}, 0))`);
    const done = await ctx.tx
      .update(schema.edgeTargets)
      .set({
        bundleHash: null,
        generation: sql`${schema.edgeTargets.generation} + 1`,
        ...(input.backfillSnapshots ? { backfillCursor: sql`CASE WHEN enabled AND snapshots THEN '' ELSE NULL END` } : {}),
        updatedAt: new Date(),
      })
      .returning({ ws: schema.edgeTargets.workspaceId });
    if (!done.length) throw new AppError('not_found', 'Edge decisions are not configured. Use edge.configure first.');
    return status(ctx.tx);
  },
});

export const edgeCommands = [edgeStatus, edgeConfigure, edgeSync] as const;

// A published experience changes the bundle: the next sync pushes it.
publishListeners.push(async (ctx, a) => {
  if (a.type === 'experience') await ctx.tx.update(schema.edgeTargets).set({ bundleHash: null });
});

// ---------- Mirroring snapshots ----------

/**
 * Hot state that also queues snapshot writes and deletions for workspaces with edge snapshots on
 * (checked at most every 30 seconds per workspace; at once in the process that ran edge.configure),
 * so the edge sees the same people. Writes in that window elsewhere are covered by the backfill a
 * new target starts with.
 */
const mirrorOn = new Map<string, { at: number; value: Promise<boolean> }>();

export function edgeMirror(hot: HotState, db: Db): HotState {
  const on = mirrorOn;
  const enabled = (ws: string) => {
    const hit = on.get(ws);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = db.admin
      .query('SELECT 1 FROM edge_targets WHERE workspace_id = $1 AND enabled AND snapshots', [ws])
      .then((r) => (r.rowCount ?? 0) > 0)
      .catch(() => false);
    on.set(ws, { at: Date.now(), value });
    return value;
  };
  // Deletions are never taken from the 30-second cache (#403): a target that just lost snapshots
  // must still receive an erasure, and a queued tombstone is retried by the scheduler.
  const remoteCopies = (ws: string) =>
    db.admin
      .query<{ enabled: boolean; snapshots: boolean; cleanupMode: string | null }>(
        'SELECT enabled, snapshots, cleanup_mode AS "cleanupMode" FROM edge_targets WHERE workspace_id = $1',
        [ws],
      )
      .then((r) => {
        const t = r.rows[0];
        return !!t && ((t.enabled && t.snapshots) || t.cleanupMode !== null);
      });
  const queue = async (ws: string, ids: { anonymousIds: string[]; userIds: string[] }, value: ProfileSnapshot | null) => {
    const keys = [...ids.anonymousIds.map((a) => kvKeys.snapshot(ws, 'a', a)), ...ids.userIds.map((u) => kvKeys.snapshot(ws, 'u', u))];
    if (!keys.length) return;
    await db.admin.query('INSERT INTO edge_outbox (workspace_id, key, value) SELECT $1, k, $3::jsonb FROM unnest($2::text[]) AS k', [
      ws,
      keys,
      value ? JSON.stringify(value) : null,
    ]);
  };
  return {
    ...hot,
    async writeSnapshot(ws, ids, snap) {
      await hot.writeSnapshot(ws, ids, snap);
      if (!(await enabled(ws))) return;
      await queue(ws, ids, snap).catch((err) => logger.warn({ err }, 'edge snapshot not queued'));
    },
    async deleteSnapshot(ws, ids) {
      await hot.deleteSnapshot(ws, ids);
      // Erasure must reach the edge too: a failure here is an error, not a warning. Only queue when
      // a remote copy can exist; a target that never served snapshots, or whose cleanup already
      // listed and deleted them, has none.
      if (!(await remoteCopies(ws))) return;
      await queue(ws, ids, null);
    },
  };
}

// ---------- Sync ----------

interface KvClient {
  put(entries: { key: string; value: string; expiration_ttl?: number }[]): Promise<void>;
  delete(keys: string[]): Promise<void>;
  /** The first page (up to 1,000 names) with this prefix; a cleanup repeats until it is empty. */
  list(prefix: string): Promise<string[]>;
}

/** Cloudflare's Workers KV bulk API (up to 10,000 entries per call). */
function cloudflareKv(
  t: { accountId: string; namespaceId: string; apiBase: string | null },
  token: string,
  egress: EgressPolicy,
): KvClient {
  const f = egressFetch(egress);
  const base = `${(t.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '')}/accounts/${t.accountId}/storage/kv/namespaces/${t.namespaceId}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const out = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: { message: string }[];
      result?: { name?: string }[];
      result_info?: { cursor?: string };
    };
    if (!res.ok || out.success === false)
      throw new Error(`Cloudflare KV ${path}: HTTP ${res.status} ${out.errors?.map((e) => e.message).join('; ') ?? ''}`);
    return out;
  };
  const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / 10_000) }, (_, i) => xs.slice(i * 10_000, (i + 1) * 10_000));
  return {
    async put(entries) {
      for (const c of chunks(entries)) await call('PUT', '/bulk', c);
    },
    async delete(keys) {
      for (const c of chunks(keys)) await call('POST', '/bulk/delete', c);
    },
    async list(prefix) {
      const out = await call('GET', `/keys?prefix=${encodeURIComponent(prefix)}&limit=1000`);
      return (out.result ?? []).map((r) => r.name).filter((n): n is string => !!n);
    },
  };
}

export interface EdgeDeps {
  db: Db;
  hot: HotState;
  kp: KeyProvider;
  egress: EgressPolicy;
}

/** Deletes every key with the snapshot prefix. KV listing can lag behind deletes, so repeat until empty. */
async function deleteSnapshots(kv: KvClient, ws: string): Promise<void> {
  const prefix = snapshotPrefix(ws);
  for (let round = 0; round < 60; round++) {
    const keys = await kv.list(prefix);
    if (!keys.length) return;
    await kv.delete(keys);
  }
  throw new Error(`KV still lists snapshots with prefix ${prefix}; the cleanup will retry`);
}

/** Removes this workspace's serving copies from one namespace: people, experiences and write keys. */
async function deleteWorkspaceCopies(kv: KvClient, ws: string, keys: string[]) {
  await deleteSnapshots(kv, ws);
  await kv.delete([...new Set([...keys, kvKeys.bundle(ws)])]);
}

/** One sync of one workspace: remote cleanup, the bundle if it changed, queued snapshots, and a slice of backfill. */
export async function syncEdge(deps: EdgeDeps, ws: string, opts: { bundleOnly?: boolean } = {}) {
  // A session lock serializes replicas without holding a transaction open during HTTP. A fresh
  // configuration can still commit; generation fences below stop the old tick before it acks
  // work or replaces the new state. The next tick cleans any late writes to the old target.
  const client = await deps.db.admin.connect();
  let locked = false;
  let destroy = false;
  try {
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [
      `edge-sync:${ws}`,
    ]);
    locked = result.rows[0].locked;
    // A stop that gave up waiting for this lock commits its share 0 while our upload may still be
    // in flight (#477); that upload can land after the stop. Republish under the same lock until
    // the bundle written last is the current one, so the stale write never stays in KV.
    for (let attempt = 0; locked && attempt < 3; attempt++)
      if ((await syncEdgeLocked(deps, ws, attempt === 0 ? opts : { bundleOnly: true })) !== 'republish') break;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`edge-sync:${ws}`]);
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}

async function syncEdgeLocked(deps: EdgeDeps, ws: string, opts: { bundleOnly?: boolean } = {}): Promise<'republish' | undefined> {
  const state = await deps.db.withWorkspace(ws, async (tx) => {
    const [t] = await tx.select().from(schema.edgeTargets);
    if (!t) return null;
    const purposes = ((await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES).map((p) => ({
      key: p.key,
      basis: p.basis,
    }));
    const bundle: EdgeBundle = { experiences: await loadPublishedExperiences(tx), purposes };
    const sources = await tx
      .select({
        keyHash: schema.sources.keyHash,
        kind: schema.sources.kind,
        requiredPurpose: schema.sources.requiredPurpose,
        enabled: schema.sources.enabled,
        allowedOrigins: schema.sources.allowedOrigins,
      })
      .from(schema.sources);
    const queued = (await tx.execute(sql`SELECT 1 FROM edge_outbox LIMIT 1`)).rows.length > 0;
    return { t, bundle, sources, queued };
  });
  if (!state) return;
  const { t, bundle, sources, queued } = state;
  const update = async (values: Partial<typeof schema.edgeTargets.$inferInsert>) => {
    const changed = await deps.db.withWorkspace(ws, (tx) =>
      tx
        .update(schema.edgeTargets)
        .set(values)
        .where(and(eq(schema.edgeTargets.workspaceId, ws), eq(schema.edgeTargets.generation, t.generation)))
        .returning({ workspaceId: schema.edgeTargets.workspaceId }),
    );
    return changed.length > 0;
  };
  // Experiences, purposes and write keys, as KV entries; pushed only when they changed.
  const entries = [
    { key: kvKeys.bundle(ws), value: JSON.stringify(bundle) },
    ...sources.map((s) => ({
      key: kvKeys.source(s.keyHash),
      value: JSON.stringify({
        workspaceId: ws,
        kind: s.kind,
        requiredPurpose: s.requiredPurpose,
        enabled: s.enabled,
        allowedOrigins: s.allowedOrigins,
      } satisfies EdgeSource),
    })),
  ];
  const hash = sha256(JSON.stringify(entries));
  const stale = t.priorTarget ?? [];
  // Nothing to do: no token is unsealed (with a KMS, that is a call per unseal). A disabled target
  // is still synced while it owes a cleanup or a queued deletion.
  const servesBundle = t.enabled && hash !== t.bundleHash;
  const servesSnapshots = t.enabled && t.snapshots;
  const backfills = servesSnapshots && t.backfillCursor !== null;
  const staleReady = stale.some((p) => !p.nextAttemptAt || Date.parse(p.nextAttemptAt) <= Date.now());
  // A stop pushes only the bundle (#477): the owner is waiting for the kill switch, so skip every
  // other slice of work this sync would do.
  if (opts.bundleOnly) {
    if (!servesBundle) return;
  } else if (!servesBundle && !queued && !backfills && !t.cleanupMode && !staleReady) return;
  if (!t.secrets || !t.secretsKeyId) {
    await update({ lastError: 'No Cloudflare API token: the edge cannot be updated or cleaned up.', lastSyncAt: new Date() });
    return;
  }
  try {
    const { apiToken } = await deps.db.withWorkspace(ws, (tx) =>
      openJson<{ apiToken: string }>(tx, ws, deps.kp, t.secrets as Buffer, t.secretsKeyId as string),
    );
    const kv = cloudflareKv(t, apiToken, deps.egress);
    // 0. Destinations we left: remove their copies, or keep them listed with the failure. The
    // current token may not reach another account; then only the operator can delete them.
    let staleError: string | null = null;
    if (stale.length && !opts.bundleOnly) {
      const keep: PriorEdgeTarget[] = [];
      for (const old of stale) {
        if (old.nextAttemptAt && Date.parse(old.nextAttemptAt) > Date.now()) {
          keep.push(old);
          continue;
        }
        try {
          const oldKv = cloudflareKv(
            { accountId: old.accountId, namespaceId: old.namespaceId, apiBase: old.apiBase ?? null },
            apiToken,
            deps.egress,
          );
          await deleteWorkspaceCopies(oldKv, ws, old.keys);
        } catch (err) {
          const message = (err as Error).message.slice(0, 500);
          logger.warn({ err, workspace: ws }, 'edge cleanup of an earlier target failed');
          keep.push({ ...old, lastError: message, nextAttemptAt: new Date(Date.now() + 15 * 60_000).toISOString() });
        }
      }
      if (keep.length)
        staleError = `${keep.length} prior edge destination(s) still require cleanup: ${keep[0].lastError ?? 'retry pending'}`;
      if (JSON.stringify(keep) !== JSON.stringify(stale)) if (!(await update({ priorTarget: keep.length ? keep : null }))) return;
    }
    // 1. Finish a cleanup owed after serving was turned off, before any write. Until it succeeds the
    // mode stays set and the next sync retries; the status never reports a cleanup that did not run.
    let removedAll = false;
    if (t.cleanupMode && !opts.bundleOnly) {
      const mode = t.cleanupMode;
      if (mode === 'all') await deleteWorkspaceCopies(kv, ws, t.pushedKeys);
      else await deleteSnapshots(kv, ws);
      removedAll = mode === 'all';
      if (!(await update({ cleanupMode: null, ...(mode === 'all' ? { pushedKeys: [], bundleHash: null } : {}) }))) return;
    }
    // 2. Experiences, purposes and write keys. Never while serving is off.
    // A stop can commit while this sync is in flight when it could not take the advisory lock in
    // time. The stop bumps `generation` (and clears `bundleHash`) in the same transaction as the
    // share, so compare that version under our lock: the bundle read before the stop must not be
    // published after it (#477). The next tick reads the stopped share and publishes it.
    const [fence] = await deps.db.withWorkspace(ws, (tx) =>
      tx.select({ generation: schema.edgeTargets.generation }).from(schema.edgeTargets).where(eq(schema.edgeTargets.workspaceId, ws)),
    );
    if (!fence || fence.generation !== t.generation) return;
    if (t.enabled && (hash !== t.bundleHash || removedAll)) {
      const keys = entries.map((e) => e.key);
      // Reserve keys before uploading: configure must retain even a write that finishes after
      // the target moves. Its row lock observes this reservation and queues the old keys.
      if (!(await update({ pushedKeys: [...new Set([...t.pushedKeys, ...keys])] }))) return;
      await kv.put(entries);
      // The upload is outside any transaction: a stop may have committed while it ran. If the
      // generation moved but the destination is the same, what we just wrote there is stale and the
      // caller republishes the current bundle under this lock. A moved destination is handled as
      // before: this tick stops and the next one cleans up and publishes in order.
      const [after] = await deps.db.withWorkspace(ws, (tx) =>
        tx
          .select({
            generation: schema.edgeTargets.generation,
            accountId: schema.edgeTargets.accountId,
            namespaceId: schema.edgeTargets.namespaceId,
          })
          .from(schema.edgeTargets)
          .where(eq(schema.edgeTargets.workspaceId, ws)),
      );
      if (!after) return;
      if (after.generation !== t.generation)
        return after.accountId === t.accountId && after.namespaceId === t.namespaceId ? 'republish' : undefined;
      const gone = t.pushedKeys.filter((k) => !keys.includes(k));
      if (gone.length) await kv.delete(gone);
      if (!(await update({ bundleHash: hash, pushedKeys: keys }))) return;
    }
    // 3. Queued snapshot writes and deletions; the latest per key wins. When snapshots are off,
    // every queued entry is deleted rather than uploaded, and erasure tombstones are never dropped.
    while (!opts.bundleOnly) {
      const { rows } = await deps.db.admin.query<{ id: string; key: string; value: unknown }>(
        'SELECT id, key, value FROM edge_outbox WHERE workspace_id = $1 ORDER BY id LIMIT 5000',
        [ws],
      );
      if (!rows.length) break;
      const latest = new Map(rows.map((r) => [r.key, r.value]));
      const puts = servesSnapshots
        ? [...latest]
            .filter(([, v]) => v !== null)
            .map(([key, v]) => ({ key, value: JSON.stringify(v), expiration_ttl: KV_SNAPSHOT_TTL_S }))
        : [];
      const deletes = servesSnapshots ? [...latest].filter(([, v]) => v === null).map(([key]) => key) : [...latest.keys()];
      if (puts.length) await kv.put(puts);
      if (deletes.length) await kv.delete(deletes);
      const acknowledged = await deps.db.admin.query(
        `DELETE FROM edge_outbox WHERE workspace_id = $1 AND id <= $2 AND EXISTS (
           SELECT 1 FROM edge_targets WHERE workspace_id = $1 AND generation = $3)`,
        [ws, rows[rows.length - 1].id, t.generation],
      );
      if (!acknowledged.rowCount) return;
      if (rows.length < 5000) break;
    }
    // 4. Backfill: everyone's snapshot, a slice per sync (written through the mirror above).
    if (!opts.bundleOnly && servesSnapshots && t.backfillCursor !== null) {
      const people = await deps.db.withWorkspace(ws, (tx) =>
        tx
          .select({ id: schema.profiles.id })
          .from(schema.profiles)
          .where(and(isNull(schema.profiles.mergedInto), sql`${schema.profiles.id} > ${t.backfillCursor}`))
          .orderBy(schema.profiles.id)
          .limit(1000),
      );
      await refreshSnapshots(
        { db: deps.db, hot: deps.hot },
        ws,
        people.map((p) => p.id),
      );
      const next = people.length === 1000 ? people[people.length - 1].id : null;
      if (!(await update({ backfillCursor: next }))) return;
    }
    if (!opts.bundleOnly) await update({ lastSyncAt: new Date(), lastError: staleError });
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    logger.warn({ err, workspace: ws }, 'edge sync failed');
    await update({ lastError: message, lastSyncAt: new Date() });
  }
}

export interface EdgePushResult {
  pushed: boolean;
  /** Why the push did not happen (or failed), for `experiences.stopRollout` to report honestly; null on success. */
  reason: string | null;
}

/**
 * Take the workspace's edge-sync advisory lock inside `tx`, waiting at most `waitMs`. Returns false
 * when another sync still holds it. The attempt lives in a savepoint because a lock timeout aborts
 * the transaction; rolling back to the savepoint keeps the caller's stop committable.
 *
 * A stop calls this before it locks or updates any rollout or edge row (#477): the background sync
 * takes this advisory lock first and only then touches `edge_targets`, so the reverse order would
 * form a deadlock.
 */
export async function acquireEdgeSyncLock(tx: Tx, ws: string, waitMs = 10_000): Promise<boolean> {
  // `pg_advisory_xact_lock` conflicts with the session-scoped `pg_try_advisory_lock` the
  // background sync takes on the same key, and is released when the caller's transaction ends.
  // The caller's own lock_timeout is restored afterwards: a leftover 10 s timeout would abort the
  // very stop this lock exists to protect, and forcing 0 would override a caller that set one.
  const original =
    (await tx.execute<{ lock_timeout: string }>(sql`SELECT current_setting('lock_timeout') AS lock_timeout`)).rows[0]?.lock_timeout ?? '0';
  await tx.execute(sql`SAVEPOINT edge_sync_lock`);
  let locked = false;
  try {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-sync:${ws}`}, 0))`);
    locked = true;
  } catch (err) {
    // Only the expected lock timeout (55P03 lock_not_available) means "another sync still runs";
    // cancellation, a statement timeout or a query error is a real failure and propagates.
    await tx.execute(sql`ROLLBACK TO SAVEPOINT edge_sync_lock`);
    // Drizzle wraps the driver error; the SQLSTATE is on the cause.
    const e = err as { code?: string; cause?: { code?: string } };
    if ((e.code ?? e.cause?.code) !== '55P03') throw err;
  }
  if (locked) await tx.execute(sql`RELEASE SAVEPOINT edge_sync_lock`);
  await tx.execute(sql`SELECT set_config('lock_timeout', ${original}, true)`);
  return locked;
}

/**
 * Pushes the current bundle inside the caller's transaction, for a person's stop (#477). The stop is
 * an emergency, so this waits for the edge-sync lock instead of skipping when another sync runs,
 * and it reads through the caller's transaction so the just-written share is included. The wait is
 * bounded (`waitMs`, 10 s by default); past it the result says the push did not happen and the
 * normal sync tick will retry. Cloudflare still has to propagate the write to other regions.
 */
export async function pushEdgeBundleNow(deps: EdgeDeps, tx: Tx, ws: string, opts: { waitMs?: number } = {}): Promise<EdgePushResult> {
  const waitMs = opts.waitMs ?? 10_000;
  if (!(await acquireEdgeSyncLock(tx, ws, waitMs)))
    return { pushed: false, reason: `another edge sync was still running after ${Math.round(waitMs / 1000)} s` };
  try {
    const [t] = await tx.select().from(schema.edgeTargets).for('update');
    if (!t) return { pushed: false, reason: 'the edge is not configured' };
    if (!t.enabled) return { pushed: false, reason: 'edge serving is turned off' };
    if (!t.secrets || !t.secretsKeyId) return { pushed: false, reason: 'no Cloudflare API token: the edge bundle cannot be pushed' };
    const purposes = ((await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES).map((p) => ({
      key: p.key,
      basis: p.basis,
    }));
    const bundle: EdgeBundle = { experiences: await loadPublishedExperiences(tx), purposes };
    const sources = await tx
      .select({
        keyHash: schema.sources.keyHash,
        kind: schema.sources.kind,
        requiredPurpose: schema.sources.requiredPurpose,
        enabled: schema.sources.enabled,
        allowedOrigins: schema.sources.allowedOrigins,
      })
      .from(schema.sources);
    const entries = [
      { key: kvKeys.bundle(ws), value: JSON.stringify(bundle) },
      ...sources.map((s) => ({
        key: kvKeys.source(s.keyHash),
        value: JSON.stringify({
          workspaceId: ws,
          kind: s.kind,
          requiredPurpose: s.requiredPurpose,
          enabled: s.enabled,
          allowedOrigins: s.allowedOrigins,
        } satisfies EdgeSource),
      })),
    ];
    const hash = sha256(JSON.stringify(entries));
    if (hash === t.bundleHash) return { pushed: true, reason: null };
    const { apiToken } = await openJson<{ apiToken: string }>(tx, ws, deps.kp, t.secrets as Buffer, t.secretsKeyId as string);
    const kv = cloudflareKv(t, apiToken, deps.egress);
    const keys = entries.map((e) => e.key);
    // Reserve the keys before uploading, as the background sync does, then write and record the hash.
    await tx
      .update(schema.edgeTargets)
      .set({ pushedKeys: [...new Set([...t.pushedKeys, ...keys])] })
      .where(and(eq(schema.edgeTargets.workspaceId, ws), eq(schema.edgeTargets.generation, t.generation)));
    await kv.put(entries);
    const gone = t.pushedKeys.filter((k) => !keys.includes(k));
    if (gone.length) await kv.delete(gone);
    await tx
      .update(schema.edgeTargets)
      .set({ bundleHash: hash, pushedKeys: keys, lastSyncAt: new Date(), lastError: null })
      .where(and(eq(schema.edgeTargets.workspaceId, ws), eq(schema.edgeTargets.generation, t.generation)));
    return { pushed: true, reason: null };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 500);
    await tx
      .update(schema.edgeTargets)
      .set({ lastError: reason, lastSyncAt: new Date() })
      .where(eq(schema.edgeTargets.workspaceId, ws))
      .catch(() => {});
    return { pushed: false, reason };
  }
}

/** Scheduler role: keeps every enabled edge target in sync, and finishes cleanup after one is turned off. */
export async function runEdgeSync(deps: EdgeDeps & { tickMs?: number }, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
        `SELECT t.workspace_id FROM edge_targets t
          WHERE t.enabled OR t.cleanup_mode IS NOT NULL OR t.prior_target IS NOT NULL
             OR EXISTS (SELECT 1 FROM edge_outbox o WHERE o.workspace_id = t.workspace_id)`,
      );
      for (const r of rows) await syncEdge(deps, r.workspace_id);
    } catch (err) {
      logger.error({ err }, 'edge sync round failed');
    }
    await delay(deps.tickMs ?? 1000, undefined, { signal }).catch((err: unknown) => {
      if (!signal.aborted) throw err;
    });
  }
}
