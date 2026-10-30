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

/** What the worker reads per workspace. */
export interface EdgeBundle {
  experiences: PublishedExperience[];
  purposes: { key: string; basis: string }[];
}

export async function loadPublishedExperiences(tx: Tx): Promise<PublishedExperience[]> {
  const rows = await tx
    .select({ id: schema.artifacts.id, version: schema.artifacts.publishedVersion, content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(
      and(eq(schema.artifacts.type, 'experience'), isNotNull(schema.artifacts.publishedVersion), eq(schema.artifacts.archived, false)),
    );
  return rows
    .map((r) => ({ id: r.id, version: r.version ?? 0, def: artifactTypes.experience.content.parse(r.content) }))
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
});

async function status(tx: Tx): Promise<z.infer<typeof Status>> {
  const [t] = await tx.select().from(schema.edgeTargets);
  const [q] = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM edge_outbox`)).rows;
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
    const sealed = input.apiToken
      ? await sealJson(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, { apiToken: input.apiToken })
      : null;
    const values = {
      accountId: input.accountId,
      namespaceId: input.namespaceId,
      apiBase: input.apiBase ?? null,
      ...(input.snapshots !== undefined ? { snapshots: input.snapshots } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(sealed ? { secrets: sealed.blob, secretsKeyId: sealed.keyId } : {}),
      // A new target gets everything again.
      bundleHash: null,
      updatedAt: new Date(),
    };
    await ctx.tx
      .insert(schema.edgeTargets)
      // A new target starts with everyone's snapshot (a backfill), then follows changes.
      .values({ workspaceId: ctx.principal.workspaceId, ...values, backfillCursor: '' })
      .onConflictDoUpdate({ target: schema.edgeTargets.workspaceId, set: values });
    ctx.afterCommit?.(async () => {
      mirrorOn.delete(ctx.principal.workspaceId);
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
    const done = await ctx.tx
      .update(schema.edgeTargets)
      .set({ bundleHash: null, ...(input.backfillSnapshots ? { backfillCursor: '' } : {}), updatedAt: new Date() })
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
  const queue = async (ws: string, ids: { anonymousIds: string[]; userIds: string[] }, value: ProfileSnapshot | null) => {
    if (!(await enabled(ws))) return;
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
      await queue(ws, ids, snap).catch((err) => logger.warn({ err }, 'edge snapshot not queued'));
    },
    async deleteSnapshot(ws, ids) {
      await hot.deleteSnapshot(ws, ids);
      // Erasure must reach the edge too: a failure here is an error, not a warning.
      await queue(ws, ids, null);
    },
  };
}

// ---------- Sync ----------

interface KvClient {
  put(entries: { key: string; value: string; expiration_ttl?: number }[]): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

/** Cloudflare's Workers KV bulk API (up to 10,000 entries per call). */
function cloudflareKv(
  t: { accountId: string; namespaceId: string; apiBase: string | null },
  token: string,
  egress: EgressPolicy,
): KvClient {
  const f = egressFetch(egress);
  const base = `${(t.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '')}/accounts/${t.accountId}/storage/kv/namespaces/${t.namespaceId}`;
  const call = async (method: string, path: string, body: unknown) => {
    const res = await f(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[] };
    if (!res.ok || out.success === false)
      throw new Error(`Cloudflare KV ${path}: HTTP ${res.status} ${out.errors?.map((e) => e.message).join('; ') ?? ''}`);
  };
  const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / 10_000) }, (_, i) => xs.slice(i * 10_000, (i + 1) * 10_000));
  return {
    async put(entries) {
      for (const c of chunks(entries)) await call('PUT', '/bulk', c);
    },
    async delete(keys) {
      for (const c of chunks(keys)) await call('POST', '/bulk/delete', c);
    },
  };
}

export interface EdgeDeps {
  db: Db;
  hot: HotState;
  kp: KeyProvider;
  egress: EgressPolicy;
}

/** One sync of one workspace: the bundle if it changed, queued snapshots, and a slice of backfill. */
export async function syncEdge(deps: EdgeDeps, ws: string) {
  const state = await deps.db.withWorkspace(ws, async (tx) => {
    const [t] = await tx.select().from(schema.edgeTargets);
    if (!t?.enabled || !t.secrets || !t.secretsKeyId) return null;
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
  // Nothing to do: no token is unsealed (with a KMS, that is a call per unseal).
  if (hash === t.bundleHash && !queued && (t.backfillCursor === null || !t.snapshots)) return;
  try {
    const { apiToken } = await deps.db.withWorkspace(ws, (tx) =>
      openJson<{ apiToken: string }>(tx, ws, deps.kp, t.secrets as Buffer, t.secretsKeyId as string),
    );
    const kv = cloudflareKv(t, apiToken, deps.egress);
    // 1. Experiences, purposes and write keys.
    if (hash !== t.bundleHash) {
      await kv.put(entries);
      const keys = entries.map((e) => e.key);
      const gone = t.pushedKeys.filter((k) => !keys.includes(k));
      if (gone.length) await kv.delete(gone);
      await deps.db.withWorkspace(ws, (tx) => tx.update(schema.edgeTargets).set({ bundleHash: hash, pushedKeys: keys }));
    }
    // 2. Queued snapshot writes and deletions; the latest per key wins.
    for (;;) {
      const { rows } = await deps.db.admin.query<{ id: string; key: string; value: unknown }>(
        'SELECT id, key, value FROM edge_outbox WHERE workspace_id = $1 ORDER BY id LIMIT 5000',
        [ws],
      );
      if (!rows.length) break;
      const latest = new Map(rows.map((r) => [r.key, r.value]));
      const puts = [...latest]
        .filter(([, v]) => v !== null)
        .map(([key, v]) => ({ key, value: JSON.stringify(v), expiration_ttl: KV_SNAPSHOT_TTL_S }));
      const deletes = [...latest].filter(([, v]) => v === null).map(([key]) => key);
      if (puts.length) await kv.put(puts);
      if (deletes.length) await kv.delete(deletes);
      await deps.db.admin.query('DELETE FROM edge_outbox WHERE workspace_id = $1 AND id <= $2', [ws, rows[rows.length - 1].id]);
      if (rows.length < 5000) break;
    }
    // 3. Backfill: everyone's snapshot, a slice per sync (written through the mirror above).
    if (t.backfillCursor !== null && t.snapshots) {
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
      await deps.db.withWorkspace(ws, (tx) => tx.update(schema.edgeTargets).set({ backfillCursor: next }));
    }
    await deps.db.withWorkspace(ws, (tx) => tx.update(schema.edgeTargets).set({ lastSyncAt: new Date(), lastError: null }));
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    logger.warn({ err, workspace: ws }, 'edge sync failed');
    await deps.db.withWorkspace(ws, (tx) => tx.update(schema.edgeTargets).set({ lastError: message, lastSyncAt: new Date() }));
  }
}

/** Scheduler role: keeps every enabled edge target in sync. */
export async function runEdgeSync(deps: EdgeDeps & { tickMs?: number }, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const { rows } = await deps.db.admin.query<{ workspace_id: string }>('SELECT workspace_id FROM edge_targets WHERE enabled');
      for (const r of rows) await syncEdge(deps, r.workspace_id);
    } catch (err) {
      logger.error({ err }, 'edge sync round failed');
    }
    await new Promise((r) => setTimeout(r, deps.tickMs ?? 1000));
  }
}
