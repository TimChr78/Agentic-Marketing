import { type AudienceSync, DEFAULT_PURPOSES, publishedSingleton, publishValidators } from '@agentic-marketing/artifacts';
import { defineCommand, type Impact } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { accessTokenOf, connectionSecrets, type EgressPolicy, safeRequest } from '@agentic-marketing/integrations';
import { consentStatusSql, profileForMessage } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { purposeHolds } from './clickIds';
import { googleEmail, googlePhone, metaEmail, metaPhone } from './hashing';
import { googleAdsConnector, metaAdsConnector } from './platforms';

// Audience sync (performance-marketing.md, flow 2): a segment's members who allowed ad_targeting,
// as hashed e-mail and phone, in a Meta custom audience and/or a Google Customer Match list. Each
// run reconciles: adds who should be in and is not, removes who left the segment, withdrew
// ad_targeting or was erased (with the hashes that were sent, kept for exactly that).

type Platform = 'meta' | 'google';
type Hashes = { email?: string; phone?: string };
const BATCH = 1000;
const MAX_ADDS_PER_RUN = 10_000;

publishValidators.set('audience_sync', async (content, tx: Tx) => {
  const a = content as AudienceSync;
  const problems: string[] = [];
  const [seg] = await tx
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, a.segment), eq(schema.artifacts.type, 'segment'), isNotNull(schema.artifacts.publishedVersion)));
  if (!seg) problems.push(`${a.segment} is not a published segment`);
  for (const [platform, connector] of [
    ['meta', metaAdsConnector.id],
    ['google', googleAdsConnector.id],
  ] as const) {
    const ref = a[platform];
    if (!ref) continue;
    const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, ref.connection));
    if (!row) problems.push(`${ref.connection} is not a connection in this workspace`);
    else if (row.connector !== connector)
      problems.push(`${platform}: ${ref.connection} is a ${row.connector} connection, not ${connector}`);
  }
  return problems;
});

/**
 * What publishing an audience sync touches, for the agent policy engine (#264): the segment whose
 * members leave the workspace (hashed) for an ad platform, so a mandate scopes it by audience.
 */
export async function audienceSyncImpact(tx: Tx, artifactId: string, version: number): Promise<Impact> {
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.number, version)));
  const segment = (v?.content as { segment?: unknown } | undefined)?.segment;
  return { touches: { segments: typeof segment === 'string' ? [segment] : [] } };
}

const hashesFor = (
  platform: Platform,
  person: { email: string | null; phone: string | null },
  allowed: AudienceSync['identifiers'],
): Hashes => {
  const out: Hashes = {};
  if (person.email && allowed.includes('email')) out.email = platform === 'meta' ? metaEmail(person.email) : googleEmail(person.email);
  if (person.phone && allowed.includes('phone')) out.phone = platform === 'meta' ? metaPhone(person.phone) : googlePhone(person.phone);
  return out;
};

type Call = (op: 'add' | 'remove', members: Hashes[]) => Promise<{ ok: true } | { ok: false; error: string }>;

const errorOf = (status: number, body: string) => {
  try {
    const b = JSON.parse(body) as { error?: { message?: string; error_user_msg?: string } };
    return `HTTP ${status}: ${b.error?.error_user_msg ?? b.error?.message ?? body.slice(0, 300)}`;
  } catch {
    return `HTTP ${status}: ${body.slice(0, 300)}`;
  }
};

function metaCall(
  row: typeof schema.connections.$inferSelect,
  secrets: Record<string, unknown>,
  audienceId: string,
  egress: EgressPolicy,
): Call {
  const settings = metaAdsConnector.settings.parse(row.settings);
  const { accessToken } = metaAdsConnector.secrets.parse(secrets);
  return async (op, members) => {
    // Multi-key upload: each row has the same columns; a missing value is empty.
    const schemaCols = (['email', 'phone'] as const).filter((k) => members.some((m) => m[k]));
    const res = await safeRequest(
      `${settings.apiBase.replace(/\/$/, '')}/${settings.apiVersion}/${audienceId}/users`,
      {
        method: op === 'add' ? 'POST' : 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: {
            schema: schemaCols.map((k) => (k === 'email' ? 'EMAIL' : 'PHONE')),
            data: members.map((m) => schemaCols.map((k) => m[k] ?? '')),
          },
          access_token: accessToken,
        }),
      },
      egress,
    );
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const error = errorOf(res.status, res.body);
    // Since January 2026 Meta refuses updates to audiences it flagged; that needs a person in Ads Manager.
    return { ok: false, error: /flag/i.test(error) ? `${error} (the audience is flagged by Meta: review it in Ads Manager)` : error };
  };
}

function googleCall(
  row: typeof schema.connections.$inferSelect,
  secrets: Record<string, unknown>,
  userListId: string,
  egress: EgressPolicy,
): Call {
  const settings = googleAdsConnector.settings.parse(row.settings);
  const token = row.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined;
  const account = (id: string) => ({ accountId: id, accountType: 'GOOGLE_ADS' });
  return async (op, members) => {
    if (!token) return { ok: false, error: 'not connected: authorize the Google Ads connection' };
    const audienceMembers = members.map((m) => ({
      userData: {
        userIdentifiers: [...(m.email ? [{ emailAddress: m.email }] : []), ...(m.phone ? [{ phoneNumber: m.phone }] : [])],
      },
      ...(op === 'add' ? { consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' } } : {}),
    }));
    const res = await safeRequest(
      `${settings.apiBase.replace(/\/$/, '')}/v1/audienceMembers:${op === 'add' ? 'ingest' : 'remove'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          destinations: [
            {
              operatingAccount: account(settings.customerId),
              ...(settings.loginCustomerId ? { loginAccount: account(settings.loginCustomerId) } : {}),
              productDestinationId: userListId,
            },
          ],
          audienceMembers,
          encoding: 'HEX',
          // Customer Match needs its terms accepted; the workspace owner did so by setting up this sync.
          ...(op === 'add' ? { termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' } } : {}),
        }),
      },
      egress,
    );
    return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, error: errorOf(res.status, res.body) };
  };
}

export interface SyncResult {
  platform: Platform;
  status: 'ok' | 'error';
  added: number;
  removed: number;
  members: number;
  error: string | null;
}

/** One reconcile of one audience sync, for each platform it targets. */
export async function syncAudience(
  db: Db,
  ws: string,
  syncId: string,
  def: AudienceSync,
  deps: { kp: KeyProvider; egress: EgressPolicy },
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const platform of ['meta', 'google'] as const) {
    const ref = def[platform];
    if (!ref) continue;
    // Who should be in, who is in, and what to send: read in one transaction, sent outside it.
    const plan = await db.withWorkspace(ws, async (tx) => {
      const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
      const rows = await tx.execute<{ profile_id: string; status: string | null }>(sql`
        SELECT m.profile_id, ${consentStatusSql(sql`m.profile_id`, 'ad_targeting')} AS status FROM segment_memberships m
        WHERE m.segment_id = ${def.segment}`);
      const desired = new Set(
        rows.rows.filter((r) => purposeHolds(purposes, 'ad_targeting', undefined, r.status ?? undefined)).map((r) => r.profile_id),
      );
      const existing = await tx
        .select()
        .from(schema.audienceMembers)
        .where(and(eq(schema.audienceMembers.syncId, syncId), eq(schema.audienceMembers.platform, platform)));
      const have = new Set(existing.map((e) => e.profileId));
      const alive = new Set(
        existing.length
          ? (
              await tx
                .select({ id: schema.profiles.id })
                .from(schema.profiles)
                .where(inArray(schema.profiles.id, [...have]))
            ).map((p) => p.id)
          : [],
      );
      // Erased people always go; leavers only when removals are on.
      const removals = existing.filter((e) => !alive.has(e.profileId) || (def.removals && !desired.has(e.profileId)));
      const adds: { profileId: string; hashes: Hashes }[] = [];
      for (const id of [...desired].filter((d) => !have.has(d)).slice(0, MAX_ADDS_PER_RUN)) {
        const person = await profileForMessage(tx, ws, id, deps.kp);
        if (!person) continue;
        const hashes = hashesFor(platform, person, def.identifiers);
        if (hashes.email || hashes.phone) adds.push({ profileId: person.id, hashes });
      }
      const [conn] = await tx.select().from(schema.connections).where(eq(schema.connections.id, ref.connection));
      return { adds, removals, conn, secrets: conn ? await connectionSecrets(tx, conn, deps.kp) : {} };
    });

    const result: SyncResult = { platform, status: 'ok', added: 0, removed: 0, members: 0, error: null };
    if (!plan.conn?.enabled) Object.assign(result, { status: 'error', error: 'the connection was deleted or disabled' });
    else {
      const call =
        platform === 'meta'
          ? metaCall(plan.conn, plan.secrets, (ref as { audienceId: string }).audienceId, deps.egress)
          : googleCall(plan.conn, plan.secrets, (ref as { userListId: string }).userListId, deps.egress);
      for (let i = 0; i < plan.removals.length && result.status === 'ok'; i += BATCH) {
        const batch = plan.removals.slice(i, i + BATCH);
        const r = await call(
          'remove',
          batch.map((b) => b.hashes as Hashes),
        ).catch((e: Error) => ({ ok: false as const, error: e.message }));
        if (!r.ok) Object.assign(result, { status: 'error', error: r.error });
        else {
          await db.withWorkspace(ws, (tx) =>
            tx.delete(schema.audienceMembers).where(
              and(
                eq(schema.audienceMembers.syncId, syncId),
                eq(schema.audienceMembers.platform, platform),
                inArray(
                  schema.audienceMembers.profileId,
                  batch.map((b) => b.profileId),
                ),
              ),
            ),
          );
          result.removed += batch.length;
        }
      }
      for (let i = 0; i < plan.adds.length && result.status === 'ok'; i += BATCH) {
        const batch = plan.adds.slice(i, i + BATCH);
        const r = await call(
          'add',
          batch.map((b) => b.hashes),
        ).catch((e: Error) => ({ ok: false as const, error: e.message }));
        if (!r.ok) Object.assign(result, { status: 'error', error: r.error });
        else {
          await db.withWorkspace(ws, (tx) =>
            tx
              .insert(schema.audienceMembers)
              .values(batch.map((b) => ({ workspaceId: ws, syncId, platform, profileId: b.profileId, hashes: b.hashes })))
              .onConflictDoNothing(),
          );
          result.added += batch.length;
        }
      }
    }
    await db.withWorkspace(ws, async (tx) => {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.audienceMembers)
        .where(and(eq(schema.audienceMembers.syncId, syncId), eq(schema.audienceMembers.platform, platform)));
      result.members = n;
      const values = {
        status: result.status,
        error: result.error,
        members: n,
        added: result.added,
        removed: result.removed,
        lastRunAt: new Date(),
      };
      await tx
        .insert(schema.audienceSyncState)
        .values({ workspaceId: ws, syncId, platform, ...values })
        .onConflictDoUpdate({
          target: [schema.audienceSyncState.workspaceId, schema.audienceSyncState.syncId, schema.audienceSyncState.platform],
          set: values,
        });
    });
    if (result.status === 'error') logger.warn({ workspace: ws, sync: syncId, platform, error: result.error }, 'audience sync failed');
    results.push(result);
  }
  return results;
}

async function publishedSyncs(tx: Tx) {
  const rows = await tx
    .select({ id: schema.artifacts.id, content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(eq(schema.artifacts.type, 'audience_sync'));
  return rows.map((r) => ({ id: r.id, def: r.content as AudienceSync }));
}

/** Scheduler role: reconciles every published audience sync, every 15 minutes. */
export async function runAudienceSyncs(deps: { db: Db; kp: KeyProvider; egress: EgressPolicy }, signal: AbortSignal, tickMs = 900_000) {
  while (!signal.aborted) {
    try {
      const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace_id FROM artifacts WHERE type = 'audience_sync' AND published_version IS NOT NULL`,
      );
      for (const { workspace_id: ws } of rows)
        for (const s of await deps.db.withWorkspace(ws, publishedSyncs)) await syncAudience(deps.db, ws, s.id, s.def, deps);
    } catch (err) {
      logger.error({ err }, 'audience sync round failed');
    }
    await new Promise<void>((r) => {
      const timer = setTimeout(r, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
}

const SyncOut = z.object({
  platform: z.enum(['meta', 'google']),
  status: z.enum(['ok', 'error']),
  added: z.number(),
  removed: z.number(),
  members: z.number(),
  error: z.string().nullable(),
});

export const listAudiences = defineCommand({
  name: 'ads.audiences',
  title: 'Audience syncs and their state',
  description:
    'Published audience syncs (segment → Meta custom audience / Google Customer Match list) with how many people are synced, the last run and its error. Members are people in the segment who allowed ad_targeting and have an e-mail or phone.',
  input: z.object({}),
  output: z.object({
    audiences: z.array(
      z.object({ id: z.string(), segment: z.string(), platforms: z.array(SyncOut.extend({ lastRunAt: z.string().nullable() })) }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_i, ctx) => {
    const syncs = await publishedSyncs(ctx.tx);
    const states = await ctx.tx.select().from(schema.audienceSyncState);
    return {
      audiences: syncs.map((s) => ({
        id: s.id,
        segment: s.def.segment,
        platforms: (['meta', 'google'] as const)
          .filter((p) => s.def[p])
          .map((p) => {
            const st = states.find((x) => x.syncId === s.id && x.platform === p);
            return {
              platform: p,
              status: st?.status ?? 'ok',
              added: st?.added ?? 0,
              removed: st?.removed ?? 0,
              members: st?.members ?? 0,
              error: st?.error ?? null,
              lastRunAt: st?.lastRunAt.toISOString() ?? null,
            };
          }),
      })),
    };
  },
});

export const runAudienceSync = defineCommand({
  name: 'ads.syncAudience',
  title: 'Sync an audience now',
  description:
    'Reconciles one published audience sync right away instead of waiting for the next run (every 15 minutes). Sends hashed identifiers to the platforms.',
  input: z.object({ artifactId: z.string().regex(/^aud_[0-9a-f]{32}$/) }),
  output: z.object({ results: z.array(SyncOut) }),
  permission: 'messages:send',
  effect: 'write',
  actionClass: 'audience.publish',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const s = (await publishedSyncs(ctx.tx)).find((x) => x.id === input.artifactId);
    if (!s) throw new AppError('not_found', `${input.artifactId} is not a published audience sync.`);
    if (!ctx.services.db) throw new AppError('conflict', 'Audience sync needs the database service.');
    return {
      results: await syncAudience(ctx.services.db, ctx.principal.workspaceId, s.id, s.def, {
        kp: ctx.services.keyProvider,
        egress: ctx.services.egress ?? { allowedHosts: [] },
      }),
    };
  },
});

declare module '@agentic-marketing/commands' {
  interface Services {
    /** The pool itself, for commands that do their own transactions (e.g. sending in batches). */
    db?: Db;
  }
}

export const adAudienceCommands = [listAudiences, runAudienceSync] as const;
