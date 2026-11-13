import { type AudienceSync, DEFAULT_PURPOSES, publishedSingleton, publishValidators } from '@agentic-marketing/artifacts';
import { defineCommand, type Impact } from '@agentic-marketing/commands';
import { AppError, safeErrorText } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { accessTokenOf, connectionSecrets, type EgressPolicy, safeRequest } from '@agentic-marketing/integrations';
import { consentStatusSql, profileForMessage } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { purposeHolds } from './clickIds';
import { googleEmail, googlePhone, metaEmail, metaPhone } from './hashing';
import { googleAdsConnector, metaAdsConnector } from './platforms';

// Audience sync (performance-marketing.md, flow 2): a segment's members who allowed ad_targeting,
// as hashed e-mail and phone, in a Meta custom audience and/or a Google Customer Match list. Each
// run reconciles: adds who should be in and is not, updates identifiers that changed, removes who
// left the segment, withdrew ad_targeting or was erased (with the hashes that were sent, kept for
// exactly that), and cleans up destinations the artifact used to point at (#400, #401, #402).
//
// Three safety rules shape this file:
//  1. A remote write is recorded as a durable intent before the HTTP call and cleared only in the
//     same transaction as the ledger row. A timeout, crash or DB failure after the provider
//     accepted the write therefore cannot leave an uploaded hash untracked for a later erasure.
//  2. Both providers remove a *user/member*, not one identifier key. Whenever a member is removed
//     for reconciliation, the full current identifier set is uploaded again.
//  3. Cleanup is independent of publication: the scheduler, `ads.audiences`, the backlog command
//     and the retry command all see rows/intents for unpublished or deleted artifacts.

type Platform = 'meta' | 'google';
type Hashes = { email?: string; phone?: string };
type ConnectionRow = typeof schema.connections.$inferSelect;

const BATCH = 1000;
const MAX_ADDS_PER_RUN = 10_000;
const MAX_REMOVALS_PER_RUN = 10_000;
const MAX_RECONCILE_PER_RUN = 10_000;
const MAX_INTENTS_PER_RUN = 10_000;
const MAX_MERGES_PER_RUN = 1_000;
const MAX_PRIOR_DESTINATIONS = 50;
const MAX_PRIOR_ROWS_PER_DESTINATION = 10_000;
const MAX_SYNCS_PER_ROUND = 500;
const MAX_BACKLOG_PAGE = 200;
const CLEANUP_PENDING_PREFIX = 'audience cleanup pending';

/** Rows uploaded before 0.7.4 have no recorded destination; the migration marks them with this key. */
export const LEGACY_DESTINATION_KEY = 'legacy:unknown';

export interface DestinationRef {
  platform: Platform;
  connectionId: string;
  destinationId: string;
  /** Google customerId; empty for Meta, whose audience id identifies the target. */
  operatingAccountId: string;
  /** Google manager account (loginCustomerId), when one was used. */
  loginAccountId: string | null;
}

/**
 * A stable identity for one platform destination. It deliberately includes the operating account
 * (Google customerId), not only the mutable connection id: changing a
 * connection's account settings must never make a cleanup claim success against a different
 * account that happens to have a list with the same id.
 */
export function destinationKeyOf(ref: DestinationRef): string {
  return [ref.connectionId, remoteTargetKeyOf(ref)].join(':');
}

/**
 * The remote target without the connection: two connections that reach the same operating account
 * and audience/list share members. Ownership and target locks use this broader identity, while
 * provenance still keeps the connection so cleanup can use the credentials that uploaded a row.
 */
export function remoteTargetKeyOf(ref: DestinationRef): string {
  return ref.platform === 'meta'
    ? ['meta', ref.destinationId].join(':')
    : [ref.platform, ref.operatingAccountId, ref.loginAccountId ?? '', ref.destinationId].join(':');
}

export function sameHashes(a: Hashes, b: Hashes): boolean {
  return (a.email ?? null) === (b.email ?? null) && (a.phone ?? null) === (b.phone ?? null);
}

export function hasAnyHashes(a: Hashes | null | undefined): a is Hashes {
  return !!a && (!!a.email || !!a.phone);
}

/** The identifiers in `stored` that are no longer current and must be removed remotely. */
export function obsoleteHashes(stored: Hashes, current: Hashes): Hashes {
  const out: Hashes = {};
  if (stored.email && stored.email !== current.email) out.email = stored.email;
  if (stored.phone && stored.phone !== current.phone) out.phone = stored.phone;
  return out;
}

/** The current identifiers not yet present remotely. */
export function addedHashes(stored: Hashes, current: Hashes): Hashes {
  const out: Hashes = {};
  if (current.email && current.email !== stored.email) out.email = current.email;
  if (current.phone && current.phone !== stored.phone) out.phone = current.phone;
  return out;
}

export interface MemberWriteInput {
  profileId: string;
  /** What the current profile/artifact should have, or null when the person must leave. */
  current: Hashes | null;
  /** What the ledger says was uploaded. */
  stored: Hashes | null;
  /** A durable intent from a previous, possibly applied write. */
  intent: Hashes | null;
}

export interface MemberWritePlan {
  profileId: string;
  /** The keyset id that was scanned, when it differs from the resolved profile (merge). */
  scanId?: string;
  /** Separate remove calls: two different e-mail values cannot share one provider payload. */
  remove: Hashes[];
  add: Hashes | null;
  final: Hashes | null;
}

/**
 * Decide the remote remove/add pair for one member. Both providers remove a whole member, so a
 * non-empty removal always re-adds the full current identifier set (P1 #401). A stored intent is
 * removed first when it differs from the current set, because its hashes may already be remote.
 */
export function planMemberWrite(input: MemberWriteInput): MemberWritePlan | null {
  const { profileId, current, stored, intent } = input;
  const remove: Hashes[] = [];
  const addRemove = (h: Hashes | null) => {
    if (!hasAnyHashes(h)) return;
    if (!remove.some((r) => sameHashes(r, h))) remove.push(h);
  };

  if (!current) {
    addRemove(stored);
    addRemove(intent);
    if (!remove.length) return stored || intent ? { profileId, remove: [], add: null, final: null } : null;
    return { profileId, remove, add: null, final: null };
  }

  const obsolete = stored ? obsoleteHashes(stored, current) : {};
  addRemove(obsolete);
  if (intent && !sameHashes(intent, current)) addRemove(intent);
  // Include the unchanged identifiers as the match bridge. A new hash alone can create a
  // second remote member instead of attaching it to the member already represented here.
  const changed = remove.length || !stored || intent || hasAnyHashes(addedHashes(stored, current));
  const add = changed ? current : null;
  if (!remove.length && !hasAnyHashes(add) && stored && !intent) return null;
  return { profileId, remove, add: hasAnyHashes(add) ? add : null, final: current };
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
 * What publishing an audience sync touches, for the agent policy engine (#264, #428): the segment
 * whose members leave the workspace (hashed) for an ad platform, so a mandate scopes it by
 * audience, and the `ads` channel.
 */
export async function audienceSyncImpact(tx: Tx, artifactId: string, version: number): Promise<Impact> {
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.number, version)));
  const segment = (v?.content as { segment?: unknown } | undefined)?.segment;
  return { touches: { segments: typeof segment === 'string' ? [segment] : [], channels: ['ads'] } };
}

// An exception's text may quote a provider or a driver, so it is redacted before it is stored in a
// sync error, a member's lastError or the audit log (#885).
export const audienceErrorText = (err: unknown) => safeErrorText(err instanceof Error ? err.message : String(err), 300);

const errorOf = (status: number, body: string) => {
  try {
    const b = JSON.parse(body) as { error?: { message?: string; error_user_msg?: string } };
    return `HTTP ${status}: ${safeErrorText(String(b.error?.error_user_msg ?? b.error?.message ?? body), 300)}`;
  } catch {
    return `HTTP ${status}: ${safeErrorText(body, 300)}`;
  }
};

type Call = (op: 'add' | 'remove', members: Hashes[]) => Promise<{ ok: true } | { ok: false; error: string }>;

function metaCall(row: ConnectionRow, secrets: Record<string, unknown>, ref: DestinationRef, egress: EgressPolicy): Call {
  const settings = metaAdsConnector.settings.parse(row.settings);
  const { accessToken } = metaAdsConnector.secrets.parse(secrets);
  return async (op, members) => {
    // Multi-key upload: each row has the same columns; a missing value is empty.
    const schemaCols = (['email', 'phone'] as const).filter((k) => members.some((m) => m[k]));
    const res = await safeRequest(
      `${settings.apiBase.replace(/\/$/, '')}/${settings.apiVersion}/${ref.destinationId}/users`,
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
    // Since January 2026 Meta refuses updates to audiences it flagged; that needs a person in Ads Manager.
    return { ok: false, error: metaAudienceError(res.status, res.body) };
  };
}

/**
 * The error of a Meta audience write. The Ads Manager guidance for a flagged audience is decided on
 * the complete body: the flag word can sit past the cut, and the guidance is what a person needs
 * (#885).
 */
export function metaAudienceError(status: number, body: string): string {
  const error = errorOf(status, body);
  return /flag/i.test(body) ? `${error} (the audience is flagged by Meta: review it in Ads Manager)` : error;
}

function googleCall(row: ConnectionRow, secrets: Record<string, unknown>, ref: DestinationRef, egress: EgressPolicy): Call {
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
              // The stored operating account, not the connection's current mutable setting (#400).
              operatingAccount: account(ref.operatingAccountId),
              ...(ref.loginAccountId ? { loginAccount: account(ref.loginAccountId) } : {}),
              productDestinationId: ref.destinationId,
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

function callFor(
  platform: Platform,
  conn: ConnectionRow,
  secrets: Record<string, unknown>,
  ref: DestinationRef,
  egress: EgressPolicy,
): { call: Call } | { error: string } {
  try {
    return { call: platform === 'meta' ? metaCall(conn, secrets, ref, egress) : googleCall(conn, secrets, ref, egress) };
  } catch (err) {
    return { error: `connection is unusable: ${audienceErrorText(err)}` };
  }
}

export interface SyncResult {
  platform: Platform;
  status: 'ok' | 'error';
  added: number;
  removed: number;
  members: number;
  /** Orphaned rows/intents that still need a removal or a person's acknowledgement. */
  unresolved: number;
  /** Durable intents whose remote write is not confirmed in the ledger yet. */
  pending: number;
  error: string | null;
}

export interface AudienceSyncDeps {
  kp: KeyProvider;
  egress: EgressPolicy;
  /** The connection/secrets resolved for the destination being written; set by the caller. */
  connection?: ConnectionRow;
  secrets?: Record<string, unknown>;
  /** Test/operator override for one run; the default is MAX_ADDS_PER_RUN. */
  maxAddsPerRun?: number;
  /** Test/operator override for how many existing members are re-checked in one run. */
  maxReconcilePerRun?: number;
  /** Test/operator override for how many removals one run plans. */
  maxRemovalsPerRun?: number;
  /** Test/operator override for how many previous-destination rows one run evacuates. */
  maxPriorPerRun?: number;
  /** Test/operator override for how many merged-away profiles are repaired in one run. */
  maxMergesPerRun?: number;
  /** Test/operator override for how many durable intents are resolved in one run. */
  maxIntentsPerRun?: number;
}

export interface SyncOptions {
  /** The artifact is unpublished: only erasure/refusal cleanup and intent recovery, never adds. */
  cleanupOnly?: boolean;
  /** The artifact no longer exists: every recorded member is a cleanup obligation. */
  removeAll?: boolean;
}

interface LoadedConnection {
  conn: ConnectionRow | null;
  secrets: Record<string, unknown>;
  error: string | null;
}

async function loadConnection(tx: Tx, id: string, kp: KeyProvider): Promise<LoadedConnection> {
  const [conn] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id));
  if (!conn) return { conn: null, secrets: {}, error: 'the connection was deleted' };
  if (!conn.enabled) return { conn, secrets: {}, error: 'the connection is disabled' };
  if (conn.connector === 'google_ads' && conn.oauthStatus !== 'connected')
    return { conn, secrets: {}, error: 'not connected: authorize the Google Ads connection' };
  try {
    return { conn, secrets: await connectionSecrets(tx, conn, kp), error: null };
  } catch (err) {
    return { conn, secrets: {}, error: `the connection's secrets are unavailable: ${audienceErrorText(err)}` };
  }
}

function refFromCurrent(platform: Platform, def: AudienceSync, conn: ConnectionRow): DestinationRef | null {
  if (platform === 'meta' && def.meta) {
    metaAdsConnector.settings.parse(conn.settings);
    return {
      platform,
      connectionId: def.meta.connection,
      destinationId: def.meta.audienceId,
      operatingAccountId: '',
      loginAccountId: null,
    };
  }
  if (platform === 'google' && def.google) {
    const settings = googleAdsConnector.settings.parse(conn.settings);
    return {
      platform,
      connectionId: def.google.connection,
      destinationId: def.google.userListId,
      operatingAccountId: settings.customerId,
      loginAccountId: settings.loginCustomerId ?? null,
    };
  }
  return null;
}

function consentCondition(profileId: SQL, basis: string) {
  return basis === 'consent'
    ? sql`${consentStatusSql(profileId, 'ad_targeting')} = 'granted'`
    : sql`coalesce(${consentStatusSql(profileId, 'ad_targeting')}, '') NOT IN ('withdrawn', 'denied', 'objected')`;
}

type Purposes = typeof DEFAULT_PURPOSES;

const chunks = <T>(items: T[], size = BATCH): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function listDestinationGroups(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  currentKey: string | null,
  limit: number,
): Promise<
  {
    destinationKey: string;
    connectionId: string | null;
    destinationId: string | null;
    operatingAccountId: string | null;
    loginAccountId: string | null;
    destinationKnown: boolean;
    rows: number;
  }[]
> {
  return db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{
      destination_key: string;
      connection_id: string | null;
      destination_id: string | null;
      operating_account_id: string | null;
      login_account_id: string | null;
      destination_known: boolean;
      rows: number;
    }>(sql`
      WITH all_rows AS (
        SELECT destination_key, connection_id, destination_id, operating_account_id, login_account_id, destination_known
        FROM audience_members
        WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform}
        UNION ALL
        SELECT destination_key, connection_id, destination_id, operating_account_id, login_account_id, true AS destination_known
        FROM audience_write_intents
        WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform}
      )
      SELECT destination_key,
             min(connection_id) AS connection_id,
             min(destination_id) AS destination_id,
             min(operating_account_id) AS operating_account_id,
             min(login_account_id) AS login_account_id,
             bool_and(destination_known) AS destination_known,
             count(*)::int AS rows
      FROM all_rows
      WHERE (${currentKey}::text IS NULL OR destination_key <> ${currentKey})
      GROUP BY destination_key
      ORDER BY destination_key
      LIMIT ${limit}`);
    return rows.map((r) => ({
      destinationKey: r.destination_key,
      connectionId: r.connection_id,
      destinationId: r.destination_id,
      operatingAccountId: r.operating_account_id,
      loginAccountId: r.login_account_id,
      destinationKnown: r.destination_known,
      rows: r.rows,
    }));
  });
}

async function markDestinationOrphaned(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  destinationKey: string,
  reason: string,
): Promise<void> {
  await db.withWorkspace(ws, async (tx) => {
    // One statement per table: never bind one parameter per row, so a >65,535-row legacy group
    // cannot exceed PostgreSQL's bind limit or abort the scheduler round.
    await tx.execute(sql`
      UPDATE audience_members
      SET orphaned_at = coalesce(orphaned_at, now()),
          orphaned_reason = ${reason},
          attempts = attempts + 1,
          last_error = ${reason},
          updated_at = now()
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform}
        AND destination_key = ${destinationKey}`);
    await tx.execute(sql`
      UPDATE audience_write_intents
      SET orphaned_at = coalesce(orphaned_at, now()),
          orphaned_reason = ${reason},
          attempts = attempts + 1,
          last_error = ${reason},
          updated_at = now()
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform}
        AND destination_key = ${destinationKey}`);
  });
}

async function markProfilesOrphaned(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  destinationKey: string,
  profileIds: string[],
  reason: string,
  kind: 'member' | 'intent' | 'both',
): Promise<void> {
  if (!profileIds.length) return;
  await db.withWorkspace(ws, async (tx) => {
    for (const ids of chunks([...new Set(profileIds)])) {
      if (kind !== 'intent')
        await tx
          .update(schema.audienceMembers)
          .set({
            orphanedAt: sql`coalesce(${schema.audienceMembers.orphanedAt}, now())`,
            orphanedReason: reason,
            attempts: sql`${schema.audienceMembers.attempts} + 1`,
            lastError: reason,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.audienceMembers.workspaceId, ws),
              eq(schema.audienceMembers.syncId, syncId),
              eq(schema.audienceMembers.platform, platform),
              eq(schema.audienceMembers.destinationKey, destinationKey),
              inArray(schema.audienceMembers.profileId, ids),
            ),
          );
      if (kind !== 'member')
        await tx
          .update(schema.audienceWriteIntents)
          .set({
            orphanedAt: sql`coalesce(${schema.audienceWriteIntents.orphanedAt}, now())`,
            orphanedReason: reason,
            attempts: sql`${schema.audienceWriteIntents.attempts} + 1`,
            lastError: reason,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.audienceWriteIntents.workspaceId, ws),
              eq(schema.audienceWriteIntents.syncId, syncId),
              eq(schema.audienceWriteIntents.platform, platform),
              eq(schema.audienceWriteIntents.destinationKey, destinationKey),
              inArray(schema.audienceWriteIntents.profileId, ids),
            ),
          );
    }
  });
}

/** Record the hashes an add is about to send, before the HTTP call. */
async function recordAddIntents(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  ref: DestinationRef,
  entries: { profileId: string; hashes: Hashes }[],
): Promise<void> {
  if (!entries.length) return;
  await db.withWorkspace(ws, (tx) =>
    tx
      .insert(schema.audienceWriteIntents)
      .values(
        entries.map((e) => ({
          workspaceId: ws,
          syncId,
          platform,
          destinationKey: destinationKeyOf(ref),
          connectionId: ref.connectionId,
          destinationId: ref.destinationId,
          operatingAccountId: ref.operatingAccountId,
          loginAccountId: ref.loginAccountId,
          profileId: e.profileId,
          op: 'add' as const,
          hashes: e.hashes,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.audienceWriteIntents.workspaceId,
          schema.audienceWriteIntents.syncId,
          schema.audienceWriteIntents.platform,
          schema.audienceWriteIntents.destinationKey,
          schema.audienceWriteIntents.profileId,
          schema.audienceWriteIntents.op,
        ],
        set: {
          hashes: sql`excluded.hashes`,
          connectionId: sql`excluded.connection_id`,
          destinationId: sql`excluded.destination_id`,
          operatingAccountId: sql`excluded.operating_account_id`,
          loginAccountId: sql`excluded.login_account_id`,
          orphanedAt: null,
          orphanedReason: null,
          lastError: null,
          updatedAt: sql`now()`,
        },
      }),
  );
}

/**
 * A remove must not delete a member another sync still owns at the same remote destination (or a
 * different profile that now holds the same identifier after a merge/reassignment). Ownership is
 * checked by actual hash values before removal; a shared profile id alone never covers a different hash.
 */
async function ownedElsewhere(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  ref: DestinationRef,
  plans: MemberWritePlan[],
): Promise<{ profiles: Set<string>; hashes: Set<string> }> {
  const profiles = new Set<string>();
  const hashes = new Set<string>();
  const profileIds = [...new Set(plans.map((p) => p.profileId))];
  const values = [...new Set(plans.flatMap((p) => p.remove.flatMap((h) => [h.email, h.phone]).filter((v): v is string => !!v)))];
  if (!profileIds.length) return { profiles, hashes };
  await db.withWorkspace(ws, async (tx) => {
    for (const ids of chunks(profileIds)) {
      const { rows } = await tx.execute<{ profile_id: string; hashes: Hashes }>(sql`
        SELECT profile_id, hashes FROM audience_members
        WHERE workspace_id = ${ws} AND platform = ${platform}
          AND (${platform} = 'meta' OR (operating_account_id = ${ref.operatingAccountId}
            AND coalesce(login_account_id, '') = ${ref.loginAccountId ?? ''}))
          AND destination_id = ${ref.destinationId}
          AND NOT (sync_id = ${syncId} AND destination_key = ${destinationKeyOf(ref)} AND profile_id = ANY(${sql.param(ids)}::text[]))
          AND (profile_id = ANY(${sql.param(ids)}::text[])
            OR hashes->>'email' = ANY(${sql.param(values)}::text[])
            OR hashes->>'phone' = ANY(${sql.param(values)}::text[]))
        UNION ALL
        SELECT profile_id, hashes FROM audience_write_intents
        WHERE workspace_id = ${ws} AND platform = ${platform}
          AND (${platform} = 'meta' OR (operating_account_id = ${ref.operatingAccountId}
            AND coalesce(login_account_id, '') = ${ref.loginAccountId ?? ''}))
          AND destination_id = ${ref.destinationId}
          AND NOT (sync_id = ${syncId} AND destination_key = ${destinationKeyOf(ref)} AND profile_id = ANY(${sql.param(ids)}::text[]))
          AND (profile_id = ANY(${sql.param(ids)}::text[])
            OR hashes->>'email' = ANY(${sql.param(values)}::text[])
            OR hashes->>'phone' = ANY(${sql.param(values)}::text[]))`);
      for (const row of rows) {
        if (profileIds.includes(row.profile_id)) profiles.add(row.profile_id);
        if (row.hashes.email && values.includes(row.hashes.email)) hashes.add(row.hashes.email);
        if (row.hashes.phone && values.includes(row.hashes.phone)) hashes.add(row.hashes.phone);
      }
    }
  });
  return { profiles, hashes };
}

async function finalizePlans(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  ref: DestinationRef,
  plans: MemberWritePlan[],
): Promise<void> {
  const destinationKey = destinationKeyOf(ref);
  const profileIds = plans.map((p) => p.profileId);
  const deletes = plans.filter((p) => !p.final).map((p) => p.profileId);
  const writes = plans.filter((p) => p.final).map((p) => p);
  await db.withWorkspace(ws, async (tx) => {
    for (const ids of chunks(deletes)) {
      await tx
        .delete(schema.audienceMembers)
        .where(
          and(
            eq(schema.audienceMembers.workspaceId, ws),
            eq(schema.audienceMembers.syncId, syncId),
            eq(schema.audienceMembers.platform, platform),
            eq(schema.audienceMembers.destinationKey, destinationKey),
            inArray(schema.audienceMembers.profileId, ids),
          ),
        );
    }
    if (writes.length) {
      await tx
        .insert(schema.audienceMembers)
        .values(
          writes.map((p) => ({
            workspaceId: ws,
            syncId,
            platform,
            destinationKey,
            connectionId: ref.connectionId,
            destinationId: ref.destinationId,
            operatingAccountId: ref.operatingAccountId,
            loginAccountId: ref.loginAccountId,
            destinationKnown: true,
            profileId: p.profileId,
            hashes: p.final!,
          })),
        )
        .onConflictDoUpdate({
          target: [
            schema.audienceMembers.workspaceId,
            schema.audienceMembers.syncId,
            schema.audienceMembers.platform,
            schema.audienceMembers.destinationKey,
            schema.audienceMembers.profileId,
          ],
          set: {
            hashes: sql`excluded.hashes`,
            connectionId: sql`excluded.connection_id`,
            destinationId: sql`excluded.destination_id`,
            operatingAccountId: sql`excluded.operating_account_id`,
            loginAccountId: sql`excluded.login_account_id`,
            destinationKnown: true,
            orphanedAt: null,
            orphanedReason: null,
            lastError: null,
            updatedAt: sql`now()`,
          },
        });
    }
    for (const ids of chunks(profileIds)) {
      await tx
        .delete(schema.audienceWriteIntents)
        .where(
          and(
            eq(schema.audienceWriteIntents.workspaceId, ws),
            eq(schema.audienceWriteIntents.syncId, syncId),
            eq(schema.audienceWriteIntents.platform, platform),
            eq(schema.audienceWriteIntents.destinationKey, destinationKey),
            inArray(schema.audienceWriteIntents.profileId, ids),
          ),
        );
    }
  });
}

interface WriteOutcome {
  added: number;
  removed: number;
  errors: string[];
  lastOk: string | null;
  retryableError?: boolean;
}

/**
 * Execute one batch of member writes: ownership filter, intent before HTTP, remove then add, and
 * a single ledger transaction that also clears the intent. HTTP never runs inside a transaction.
 */
async function writePlans(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  ref: DestinationRef,
  plans: MemberWritePlan[],
  deps: AudienceSyncDeps,
  opts: { stopOnError?: boolean } = {},
): Promise<WriteOutcome> {
  const outcome: WriteOutcome = { added: 0, removed: 0, errors: [], lastOk: null };
  if (!deps.connection) {
    outcome.retryableError = true;
    outcome.errors.push('no usable connection was resolved for this destination');
    return outcome;
  }
  const call = callFor(platform, deps.connection, deps.secrets ?? {}, ref, deps.egress);
  if ('error' in call) {
    outcome.retryableError = true;
    outcome.errors.push(call.error);
    return outcome;
  }
  for (const batch of chunks(plans)) {
    const owned = await ownedElsewhere(db, ws, syncId, platform, ref, batch);
    // A provider remove deletes the whole member. Partial overlap cannot be safely closed:
    // retain every hash (including ambiguous intents) as a visible manual cleanup obligation.
    const safe: MemberWritePlan[] = [];
    for (const p of batch) {
      const partial = p.remove.some((h) => {
        const values = [h.email, h.phone].filter((v): v is string => !!v);
        const shared = values.filter((v) => owned.hashes.has(v)).length;
        return shared > 0 && shared < values.length;
      });
      if (partial) {
        const reason = `${CLEANUP_PENDING_PREFIX}: identifiers partially overlap another member; manual removal and restoration are required`;
        await markProfilesOrphaned(db, ws, syncId, platform, destinationKeyOf(ref), [p.profileId], reason, 'both');
        outcome.errors.push(reason);
      } else safe.push(p);
    }
    const send = safe.map((p) => ({
      plan: p,
      remove: p.remove.filter((h) => ![h.email, h.phone].some((v) => v && owned.hashes.has(v))),
    }));
    const removeSets = send.flatMap((s) => s.remove);
    const addEntries = send.filter((s) => s.plan.add).map((s) => ({ profileId: s.plan.profileId, hashes: s.plan.add! }));
    let failed = false;
    if (removeSets.length) {
      const r = await call.call('remove', removeSets).catch((e: Error) => ({ ok: false as const, error: audienceErrorText(e) }));
      if (!r.ok) {
        const ids = send.filter((s) => s.remove.length).map((s) => s.plan.profileId);
        await markProfilesOrphaned(db, ws, syncId, platform, destinationKeyOf(ref), ids, `removal failed: ${r.error}`, 'both');
        outcome.errors.push(`removal failed: ${r.error}`);
        failed = true;
      }
    }
    if (!failed && addEntries.length) {
      // Durable coverage before the remote add/update, so a timeout or DB failure after this
      // point can still remove the hash on a later erasure.
      await recordAddIntents(db, ws, syncId, platform, ref, addEntries);
      const r = await call
        .call(
          'add',
          addEntries.map((e) => e.hashes),
        )
        .catch((e: Error) => ({ ok: false as const, error: audienceErrorText(e) }));
      if (!r.ok) {
        await markProfilesOrphaned(
          db,
          ws,
          syncId,
          platform,
          destinationKeyOf(ref),
          addEntries.map((e) => e.profileId),
          `addition was attempted but not confirmed: ${r.error}`,
          'intent',
        );
        outcome.errors.push(`addition failed: ${r.error}`);
        failed = true;
      }
    }
    if (failed) {
      outcome.retryableError = true;
      if (opts.stopOnError) return outcome;
      continue;
    }
    try {
      await finalizePlans(db, ws, syncId, platform, ref, safe);
    } catch (err) {
      outcome.retryableError = true;
      // The intents stay: a later run or erasure can still remove what the provider accepted.
      outcome.errors.push(`recording the audience ledger failed: ${audienceErrorText(err)}`);
      if (opts.stopOnError) return outcome;
      continue;
    }
    outcome.added += addEntries.length;
    outcome.removed += send.filter((s) => s.remove.length).length;
    outcome.lastOk = safe.at(-1)?.scanId ?? safe.at(-1)?.profileId ?? outcome.lastOk;
  }
  return outcome;
}

async function evacuateDestination(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  ref: DestinationRef,
  limit: number,
  deps: AudienceSyncDeps,
): Promise<WriteOutcome> {
  const destinationKey = destinationKeyOf(ref);
  const { members, intents } = await db.withWorkspace(ws, async (tx) => {
    const members = await tx.execute<{ profile_id: string; hashes: Hashes }>(sql`
      SELECT profile_id, hashes FROM audience_members
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform} AND destination_key = ${destinationKey}
      ORDER BY profile_id LIMIT ${limit}`);
    const intents = await tx.execute<{ profile_id: string; hashes: Hashes }>(sql`
      SELECT profile_id, hashes FROM audience_write_intents
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform} AND destination_key = ${destinationKey}
      ORDER BY profile_id LIMIT ${limit}`);
    return { members: members.rows, intents: intents.rows };
  });
  const byProfile = new Map<string, { stored: Hashes | null; intent: Hashes | null }>();
  for (const r of members) byProfile.set(r.profile_id, { stored: r.hashes, intent: byProfile.get(r.profile_id)?.intent ?? null });
  for (const r of intents) byProfile.set(r.profile_id, { stored: byProfile.get(r.profile_id)?.stored ?? null, intent: r.hashes });
  const plans: MemberWritePlan[] = [];
  for (const [profileId, h] of byProfile) {
    const plan = planMemberWrite({ profileId, current: null, stored: h.stored, intent: h.intent });
    if (plan) plans.push(plan);
  }
  return writePlans(db, ws, syncId, platform, ref, plans, deps, { stopOnError: false });
}

async function eligibilityMap(tx: Tx, ws: string, purposes: Purposes, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  for (const chunk of chunks([...new Set(ids)])) {
    const { rows } = await tx.execute<{ id: string; status: string | null }>(sql`
      SELECT p.id, ${consentStatusSql(sql`p.id`, 'ad_targeting')} AS status
      FROM profiles p WHERE p.workspace_id = ${ws} AND p.id = ANY(${sql.param(chunk)}::text[])`);
    for (const row of rows) if (purposeHolds(purposes, 'ad_targeting', undefined, row.status ?? undefined)) out.add(row.id);
  }
  return out;
}

async function segmentMap(tx: Tx, ws: string, segment: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  for (const chunk of chunks([...new Set(ids)])) {
    const { rows } = await tx.execute<{ profile_id: string }>(sql`
      SELECT profile_id FROM segment_memberships
      WHERE workspace_id = ${ws} AND segment_id = ${segment} AND profile_id = ANY(${sql.param(chunk)}::text[])`);
    for (const row of rows) out.add(row.profile_id);
  }
  return out;
}

async function memberHashes(tx: Tx, ws: string, syncId: string, platform: Platform, destinationKey: string, ids: string[]) {
  const out = new Map<string, Hashes>();
  if (!ids.length) return out;
  for (const chunk of chunks([...new Set(ids)])) {
    const rows = await tx
      .select({ profileId: schema.audienceMembers.profileId, hashes: schema.audienceMembers.hashes })
      .from(schema.audienceMembers)
      .where(
        and(
          eq(schema.audienceMembers.workspaceId, ws),
          eq(schema.audienceMembers.syncId, syncId),
          eq(schema.audienceMembers.platform, platform),
          eq(schema.audienceMembers.destinationKey, destinationKey),
          inArray(schema.audienceMembers.profileId, chunk),
        ),
      );
    for (const row of rows) out.set(row.profileId, row.hashes);
  }
  return out;
}

/** Resolve a durable intent at the current destination, including the full current hash set. */
async function processCurrentIntents(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  def: AudienceSync,
  ref: DestinationRef,
  purposes: Purposes,
  deps: AudienceSyncDeps,
  opts: { removeLeavers: boolean; limit: number },
): Promise<WriteOutcome> {
  const destinationKey = destinationKeyOf(ref);
  const plans = await db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ profile_id: string; hashes: Hashes }>(sql`
      SELECT profile_id, hashes FROM audience_write_intents
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform} AND destination_key = ${destinationKey}
      ORDER BY profile_id LIMIT ${opts.limit}`);
    const ids = rows.map((r) => r.profile_id);
    if (!ids.length) return [] as MemberWritePlan[];
    const eligible = await eligibilityMap(tx, ws, purposes, ids);
    const inSegment = await segmentMap(tx, ws, def.segment, ids);
    const stored = await memberHashes(tx, ws, syncId, platform, destinationKey, ids);
    const out: MemberWritePlan[] = [];
    for (const row of rows) {
      const person = await profileForMessage(tx, ws, row.profile_id, deps.kp);
      const wanted =
        !!person && person.id === row.profile_id && eligible.has(row.profile_id) && (inSegment.has(row.profile_id) || !opts.removeLeavers);
      const current = wanted ? hashesFor(platform, person, def.identifiers) : null;
      const plan = planMemberWrite({
        profileId: row.profile_id,
        current: hasAnyHashes(current) ? current : null,
        stored: stored.get(row.profile_id) ?? null,
        intent: row.hashes,
      });
      if (plan) out.push(plan);
    }
    return out;
  });
  return writePlans(db, ws, syncId, platform, ref, plans, deps, { stopOnError: false });
}

async function processMergeRepair(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  ref: DestinationRef,
  deps: AudienceSyncDeps,
  def: AudienceSync,
  purposes: Purposes,
  limit: number,
): Promise<{ repaired: number; errors: string[] }> {
  const destinationKey = destinationKeyOf(ref);
  const restores: MemberWritePlan[] = [];
  const plans = await db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ profile_id: string; hashes: Hashes; merged_into: string }>(sql`
      SELECT m.profile_id, m.hashes, p.merged_into
      FROM audience_members m
      JOIN profiles p ON p.workspace_id = m.workspace_id AND p.id = m.profile_id
      WHERE m.workspace_id = ${ws} AND m.sync_id = ${syncId} AND m.platform = ${platform}
        AND m.destination_key = ${destinationKey} AND p.merged_into IS NOT NULL
      ORDER BY m.profile_id LIMIT ${limit}`);
    const out: MemberWritePlan[] = [];
    for (const row of rows) {
      const [mergedIntent] = await tx
        .select({ hashes: schema.audienceWriteIntents.hashes })
        .from(schema.audienceWriteIntents)
        .where(
          and(
            eq(schema.audienceWriteIntents.workspaceId, ws),
            eq(schema.audienceWriteIntents.syncId, syncId),
            eq(schema.audienceWriteIntents.platform, platform),
            eq(schema.audienceWriteIntents.destinationKey, destinationKey),
            eq(schema.audienceWriteIntents.profileId, row.profile_id),
          ),
        );
      let survivor: string | null = row.merged_into;
      for (let i = 0; i < 20 && survivor; i++) {
        const [p] = await tx
          .select({ mergedInto: schema.profiles.mergedInto })
          .from(schema.profiles)
          .where(and(eq(schema.profiles.workspaceId, ws), eq(schema.profiles.id, survivor)));
        if (!p) {
          survivor = null;
          break;
        }
        if (!p.mergedInto) break;
        survivor = p.mergedInto;
      }
      if (!survivor) {
        const plan = planMemberWrite({
          profileId: row.profile_id,
          current: null,
          stored: row.hashes,
          intent: mergedIntent?.hashes ?? null,
        });
        if (plan) out.push(plan);
        continue;
      }
      const [survivorRow] = await tx
        .select({ hashes: schema.audienceMembers.hashes })
        .from(schema.audienceMembers)
        .where(
          and(
            eq(schema.audienceMembers.workspaceId, ws),
            eq(schema.audienceMembers.syncId, syncId),
            eq(schema.audienceMembers.platform, platform),
            eq(schema.audienceMembers.destinationKey, destinationKey),
            eq(schema.audienceMembers.profileId, survivor),
          ),
        );
      if (survivorRow) {
        // The survivor's ledger row already represents the remote member. Delete the duplicate
        // row; if it held an extra old hash, remove that separate user first.
        if (sameHashes(survivorRow.hashes, row.hashes)) {
          await tx
            .delete(schema.audienceMembers)
            .where(
              and(
                eq(schema.audienceMembers.workspaceId, ws),
                eq(schema.audienceMembers.syncId, syncId),
                eq(schema.audienceMembers.platform, platform),
                eq(schema.audienceMembers.destinationKey, destinationKey),
                eq(schema.audienceMembers.profileId, row.profile_id),
              ),
            );
        } else {
          const plan = planMemberWrite({
            profileId: row.profile_id,
            current: null,
            stored: row.hashes,
            intent: mergedIntent?.hashes ?? null,
          });
          if (plan) out.push(plan);
          const allowed = await eligibilityMap(tx, ws, purposes, [survivor]);
          const [membership] = await tx
            .select({ id: schema.segmentMemberships.profileId })
            .from(schema.segmentMemberships)
            .where(
              and(
                eq(schema.segmentMemberships.workspaceId, ws),
                eq(schema.segmentMemberships.segmentId, def.segment),
                eq(schema.segmentMemberships.profileId, survivor),
              ),
            );
          const person =
            allowed.has(survivor) && (membership || def.removals === false) ? await profileForMessage(tx, ws, survivor, deps.kp) : null;
          const current = person ? hashesFor(platform, person, def.identifiers) : null;
          if (hasAnyHashes(current)) {
            const [intent] = await tx
              .select({ hashes: schema.audienceWriteIntents.hashes })
              .from(schema.audienceWriteIntents)
              .where(
                and(
                  eq(schema.audienceWriteIntents.workspaceId, ws),
                  eq(schema.audienceWriteIntents.syncId, syncId),
                  eq(schema.audienceWriteIntents.platform, platform),
                  eq(schema.audienceWriteIntents.destinationKey, destinationKey),
                  eq(schema.audienceWriteIntents.profileId, survivor),
                ),
              );
            const restore = planMemberWrite({ profileId: survivor, current, stored: survivorRow.hashes, intent: intent?.hashes ?? null });
            // Even unchanged hashes need an add after the merged-away member's removal.
            restores.push(restore ?? { profileId: survivor, remove: [], add: current, final: current });
          }
        }
      } else {
        // Move the row to the survivor so a later removal cannot delete the person while the
        // survivor is still in the segment. A concurrent insert wins; then the old row is a
        // duplicate and is deleted.
        const updated = await tx.execute<{ profile_id: string }>(sql`
          UPDATE audience_members
          SET profile_id = ${survivor}, updated_at = now()
          WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform}
            AND destination_key = ${destinationKey} AND profile_id = ${row.profile_id}
            AND NOT EXISTS (
              SELECT 1 FROM audience_members s
              WHERE s.workspace_id = ${ws} AND s.sync_id = ${syncId} AND s.platform = ${platform}
                AND s.destination_key = ${destinationKey} AND s.profile_id = ${survivor})
          RETURNING profile_id`);
        if (!updated.rows.length) {
          await tx
            .delete(schema.audienceMembers)
            .where(
              and(
                eq(schema.audienceMembers.workspaceId, ws),
                eq(schema.audienceMembers.syncId, syncId),
                eq(schema.audienceMembers.platform, platform),
                eq(schema.audienceMembers.destinationKey, destinationKey),
                eq(schema.audienceMembers.profileId, row.profile_id),
              ),
            );
        }
      }
    }
    return out;
  });
  const outcome = await writePlans(db, ws, syncId, platform, ref, plans, deps, { stopOnError: false });
  const restore = await writePlans(db, ws, syncId, platform, ref, [...new Map(restores.map((p) => [p.profileId, p])).values()], deps);
  return { repaired: outcome.removed, errors: [...outcome.errors, ...restore.errors] };
}

async function processRemovals(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  def: AudienceSync,
  ref: DestinationRef,
  purposes: Purposes,
  deps: AudienceSyncDeps,
  limit: number,
): Promise<WriteOutcome> {
  const destinationKey = destinationKeyOf(ref);
  const removeLeavers = def.removals !== false;
  const basis = purposes.find((p) => p.key === 'ad_targeting')?.basis ?? 'consent';
  const eligible = consentCondition(sql`p.id`, basis);
  const inSegment = sql`EXISTS (
    SELECT 1 FROM segment_memberships sm
    WHERE sm.workspace_id = ${ws} AND sm.segment_id = ${def.segment} AND sm.profile_id = m.profile_id)`;
  const plans = await db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ profile_id: string; hashes: Hashes }>(sql`
      SELECT m.profile_id, m.hashes
      FROM audience_members m
      LEFT JOIN profiles p ON p.workspace_id = m.workspace_id AND p.id = m.profile_id
      WHERE m.workspace_id = ${ws} AND m.sync_id = ${syncId} AND m.platform = ${platform}
        AND m.destination_key = ${destinationKey}
        AND (p.id IS NULL OR p.merged_into IS NULL)
        AND (p.id IS NULL OR NOT (${eligible}) OR (${removeLeavers} AND NOT (${inSegment})))
        AND NOT EXISTS (
          SELECT 1 FROM audience_write_intents w
          WHERE w.workspace_id = ${ws} AND w.sync_id = ${syncId} AND w.platform = ${platform}
            AND w.destination_key = ${destinationKey} AND w.profile_id = m.profile_id)
      ORDER BY m.profile_id LIMIT ${limit}`);
    const out: MemberWritePlan[] = [];
    for (const row of rows) {
      const plan = planMemberWrite({ profileId: row.profile_id, current: null, stored: row.hashes, intent: null });
      if (plan) out.push(plan);
    }
    return out;
  });
  return writePlans(db, ws, syncId, platform, ref, plans, deps, { stopOnError: false });
}

async function processReconcile(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  def: AudienceSync,
  ref: DestinationRef,
  purposes: Purposes,
  cursor: string | null,
  deps: AudienceSyncDeps,
  limit: number,
): Promise<{ next: string | null; complete: boolean; outcome: WriteOutcome }> {
  const destinationKey = destinationKeyOf(ref);
  const removeLeavers = def.removals !== false;
  const basis = purposes.find((p) => p.key === 'ad_targeting')?.basis ?? 'consent';
  const eligible = consentCondition(sql`p.id`, basis);
  const inSegment = sql`EXISTS (
    SELECT 1 FROM segment_memberships sm
    WHERE sm.workspace_id = ${ws} AND sm.segment_id = ${def.segment} AND sm.profile_id = m.profile_id)`;
  const { plans, lastId, complete } = await db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ profile_id: string; hashes: Hashes; orphaned_at: Date | null }>(sql`
      SELECT m.profile_id, m.hashes, m.orphaned_at
      FROM audience_members m
      JOIN profiles p ON p.workspace_id = m.workspace_id AND p.id = m.profile_id
      WHERE m.workspace_id = ${ws} AND m.sync_id = ${syncId} AND m.platform = ${platform}
        AND m.destination_key = ${destinationKey} AND p.merged_into IS NULL
        AND (${eligible}) AND (${inSegment} OR NOT ${removeLeavers})
        AND m.profile_id > ${cursor ?? ''}
        AND NOT EXISTS (
          SELECT 1 FROM audience_write_intents w
          WHERE w.workspace_id = ${ws} AND w.sync_id = ${syncId} AND w.platform = ${platform}
            AND w.destination_key = ${destinationKey} AND w.profile_id = m.profile_id)
      ORDER BY m.profile_id LIMIT ${limit}`);
    const out: MemberWritePlan[] = [];
    for (const row of rows) {
      const person = await profileForMessage(tx, ws, row.profile_id, deps.kp);
      const current = person ? hashesFor(platform, person, def.identifiers) : null;
      const wanted = hasAnyHashes(current) ? current : null;
      if (wanted && row.orphaned_at && sameHashes(row.hashes, wanted)) {
        // Reachable again after an earlier failure: re-add the same hashes (idempotent) and let
        // the ledger write clear the orphan marker. Without this the unresolved count would
        // never return to zero after a re-enabled connection.
        out.push({ profileId: row.profile_id, remove: [], add: wanted, final: wanted });
        continue;
      }
      const plan = planMemberWrite({
        profileId: row.profile_id,
        current: wanted,
        stored: row.hashes,
        intent: null,
      });
      if (plan) out.push(plan);
    }
    return { plans: out, lastId: rows.at(-1)?.profile_id ?? null, complete: rows.length < limit };
  });
  const outcome = await writePlans(db, ws, syncId, platform, ref, plans, deps, { stopOnError: true });
  const next = outcome.retryableError ? (outcome.lastOk ?? cursor) : complete ? null : lastId;
  return { next, complete, outcome };
}

async function processAdditions(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  def: AudienceSync,
  ref: DestinationRef,
  purposes: Purposes,
  cursor: string | null,
  deps: AudienceSyncDeps,
  limit: number,
): Promise<{ next: string | null; outcome: WriteOutcome }> {
  if (limit <= 0) return { next: cursor, outcome: { added: 0, removed: 0, errors: [], lastOk: null } };
  const destinationKey = destinationKeyOf(ref);
  const basis = purposes.find((p) => p.key === 'ad_targeting')?.basis ?? 'consent';
  const consentConditionSql =
    basis === 'consent'
      ? sql`${consentStatusSql(sql`m.profile_id`, 'ad_targeting')} = 'granted'`
      : sql`coalesce(${consentStatusSql(sql`m.profile_id`, 'ad_targeting')}, '') NOT IN ('withdrawn', 'denied', 'objected')`;
  const { plans, lastScan, complete } = await db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT m.profile_id AS id
      FROM segment_memberships m
      JOIN profiles p ON p.workspace_id = ${ws} AND p.id = m.profile_id
      WHERE m.workspace_id = ${ws} AND m.segment_id = ${def.segment}
        AND p.merged_into IS NULL
        AND m.profile_id > ${cursor ?? ''}
        AND ${consentConditionSql}
        AND EXISTS (
          SELECT 1 FROM identifiers i
          WHERE i.workspace_id = ${ws} AND i.profile_id = m.profile_id
            AND i.type = ANY(${sql.param(def.identifiers)}::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM audience_members a
          WHERE a.workspace_id = ${ws} AND a.sync_id = ${syncId} AND a.platform = ${platform}
            AND a.destination_key = ${destinationKey} AND a.profile_id = m.profile_id)
        AND NOT EXISTS (
          SELECT 1 FROM audience_write_intents w
          WHERE w.workspace_id = ${ws} AND w.sync_id = ${syncId} AND w.platform = ${platform}
            AND w.destination_key = ${destinationKey} AND w.profile_id = m.profile_id)
      ORDER BY m.profile_id
      LIMIT ${limit}`);
    const out: MemberWritePlan[] = [];
    for (const row of rows) {
      const person = await profileForMessage(tx, ws, row.id, deps.kp);
      if (!person) continue;
      const current = hashesFor(platform, person, def.identifiers);
      if (!hasAnyHashes(current)) continue;
      const plan = planMemberWrite({ profileId: person.id, current, stored: null, intent: null });
      if (plan) out.push({ ...plan, scanId: row.id });
    }
    return { plans: out, lastScan: rows.at(-1)?.id ?? null, complete: rows.length < limit };
  });
  const outcome = await writePlans(db, ws, syncId, platform, ref, plans, deps, { stopOnError: true });
  const next = outcome.errors.length ? (outcome.lastOk ?? cursor) : complete ? null : lastScan;
  return { next, outcome };
}

async function cleanupOnlyDestination(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  ref: DestinationRef,
  purposes: Purposes,
  deps: AudienceSyncDeps,
  limit: number,
  currentKey: string | null,
): Promise<WriteOutcome> {
  const destinationKey = destinationKeyOf(ref);
  const basis = purposes.find((p) => p.key === 'ad_targeting')?.basis ?? 'consent';
  const eligible = consentCondition(sql`p.id`, basis);
  const plans = await db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ profile_id: string; hashes: Hashes; eligible: boolean; orphaned_at: Date | null }>(sql`
      SELECT m.profile_id, m.hashes, m.orphaned_at,
             (p.id IS NOT NULL AND p.merged_into IS NULL AND (${eligible})) AS eligible
      FROM audience_members m
      LEFT JOIN profiles p ON p.workspace_id = m.workspace_id AND p.id = m.profile_id
      WHERE m.workspace_id = ${ws} AND m.sync_id = ${syncId} AND m.platform = ${platform}
        AND m.destination_key = ${destinationKey}
        AND (p.id IS NULL OR (p.merged_into IS NULL AND (NOT (${eligible})
          OR (m.orphaned_at IS NOT NULL AND ${currentKey}::text = ${destinationKey}))))
      ORDER BY m.profile_id LIMIT ${limit}`);
    const out: MemberWritePlan[] = [];
    for (const row of rows) {
      if (row.eligible && row.orphaned_at) {
        // The last known current destination is reachable again: confirm the stored hashes and
        // clear the orphan marker without uploading a new identifier from an unpublished draft.
        out.push({ profileId: row.profile_id, remove: [], add: row.hashes, final: row.hashes });
        continue;
      }
      const plan = planMemberWrite({ profileId: row.profile_id, current: null, stored: row.hashes, intent: null });
      if (plan) out.push(plan);
    }
    // A durable intent is ambiguous: complete it (to cover the remote hash in the ledger) when
    // the person is still eligible, otherwise remove it.
    const { rows: intents } = await tx.execute<{ profile_id: string; hashes: Hashes }>(sql`
      SELECT profile_id, hashes FROM audience_write_intents
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform} AND destination_key = ${destinationKey}
      ORDER BY profile_id LIMIT ${limit}`);
    const ids = intents.map((i) => i.profile_id);
    if (ids.length) {
      const eligibleIds = await eligibilityMap(tx, ws, purposes, ids);
      const stored = await memberHashes(tx, ws, syncId, platform, destinationKey, ids);
      for (const intent of intents) {
        const person = await profileForMessage(tx, ws, intent.profile_id, deps.kp);
        // A merged-away intent needs the full-sync merge repair: removing it here could remove
        // the survivor's only remote copy while this cleanup-only run may not add the survivor.
        if (person && person.id !== intent.profile_id) continue;
        const wanted = !!person && eligibleIds.has(intent.profile_id);
        // Complete the attempted hashes, not whatever the current draft now says: an unpublished
        // edit must not make this cleanup-only run upload a new identifier.
        const current = wanted ? intent.hashes : null;
        const plan = planMemberWrite({
          profileId: intent.profile_id,
          current: hasAnyHashes(current) ? current : null,
          stored: stored.get(intent.profile_id) ?? null,
          intent: intent.hashes,
        });
        if (plan) out.push(plan);
      }
    }
    // A member row and its intent can both be selected above; merge them so one profile is
    // removed/recorded once per run.
    const byProfile = new Map<string, MemberWritePlan>();
    for (const plan of out) {
      const prev = byProfile.get(plan.profileId);
      if (!prev) {
        byProfile.set(plan.profileId, plan);
        continue;
      }
      const remove = [...prev.remove];
      for (const h of plan.remove) if (!remove.some((r) => sameHashes(r, h))) remove.push(h);
      const final = prev.final && plan.final ? plan.final : null;
      byProfile.set(plan.profileId, {
        profileId: plan.profileId,
        remove,
        add: final ? (plan.add ?? prev.add) : null,
        final,
      });
    }
    return [...byProfile.values()];
  });
  return writePlans(db, ws, syncId, platform, ref, plans, deps, { stopOnError: false });
}

async function countsFor(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  currentKey: string | null,
): Promise<{ members: number; unresolved: number; pending: number }> {
  return db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{ members: number; orphaned: number }>(sql`
      SELECT count(*) FILTER (WHERE ${currentKey}::text IS NULL OR destination_key = ${currentKey})::int AS members,
             count(*) FILTER (WHERE NOT destination_known OR orphaned_at IS NOT NULL)::int AS orphaned
      FROM audience_members
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform}`);
    const { rows: intentRows } = await tx.execute<{ orphaned: number; pending: number }>(sql`
      SELECT count(*) FILTER (WHERE orphaned_at IS NOT NULL)::int AS orphaned,
             count(*)::int AS pending
      FROM audience_write_intents
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${platform}`);
    const orphaned = (rows[0]?.orphaned ?? 0) + (intentRows[0]?.orphaned ?? 0);
    const pending = intentRows[0]?.pending ?? 0;
    return { members: rows[0]?.members ?? 0, unresolved: orphaned + pending, pending };
  });
}

async function saveState(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  values: {
    status: 'ok' | 'error';
    error: string | null;
    members: number;
    added: number;
    removed: number;
    destinationKey: string | null;
    lastProfileId: string | null;
    reconcileProfileId: string | null;
    unresolved: number;
  },
): Promise<void> {
  await db.withWorkspace(ws, (tx) =>
    tx
      .insert(schema.audienceSyncState)
      .values({ workspaceId: ws, syncId, platform, ...values, lastRunAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.audienceSyncState.workspaceId, schema.audienceSyncState.syncId, schema.audienceSyncState.platform],
        set: { ...values, lastRunAt: new Date() },
      }),
  );
}

function resultOf(platform: Platform, error: string | null, counts?: { members: number; unresolved: number; pending: number }): SyncResult {
  return {
    platform,
    status: error ? 'error' : 'ok',
    added: 0,
    removed: 0,
    members: counts?.members ?? 0,
    unresolved: counts?.unresolved ?? 0,
    pending: counts?.pending ?? 0,
    error,
  };
}

/** Evacuate every destination for a platform; used when the artifact was deleted. */
async function removeAllPlatform(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  deps: AudienceSyncDeps,
  limit: number,
): Promise<SyncResult> {
  const errors: string[] = [];
  let removed = 0;
  const groups = await listDestinationGroups(db, ws, syncId, platform, null, MAX_PRIOR_DESTINATIONS);
  for (const group of groups) {
    const ref =
      group.destinationKnown && group.connectionId && group.destinationId && group.operatingAccountId !== null
        ? {
            platform,
            connectionId: group.connectionId,
            destinationId: group.destinationId,
            operatingAccountId: group.operatingAccountId,
            loginAccountId: group.loginAccountId,
          }
        : null;
    if (!ref) {
      await markDestinationOrphaned(db, ws, syncId, platform, group.destinationKey, 'uploaded before 0.7.4: destination was not recorded');
      errors.push(`${CLEANUP_PENDING_PREFIX} for ${group.rows} member(s): the destination was not recorded`);
      continue;
    }
    const loaded = await db.withWorkspace(ws, (tx) => loadConnection(tx, ref.connectionId, deps.kp));
    if (loaded.error) {
      await markDestinationOrphaned(db, ws, syncId, platform, group.destinationKey, `${CLEANUP_PENDING_PREFIX}: ${loaded.error}`);
      errors.push(`${CLEANUP_PENDING_PREFIX} for ${group.rows} member(s): ${loaded.error}`);
      continue;
    }
    const outcome = await evacuateDestination(db, ws, syncId, platform, ref, limit, {
      ...deps,
      connection: loaded.conn!,
      secrets: loaded.secrets,
    });
    removed += outcome.removed;
    errors.push(...outcome.errors);
  }
  const counts = await countsFor(db, ws, syncId, platform, null);
  const error = errors.length ? [...new Set(errors)].join('; ') : null;
  await saveState(db, ws, syncId, platform, {
    status: error ? 'error' : 'ok',
    error,
    members: counts.members,
    added: 0,
    removed,
    destinationKey: null,
    lastProfileId: null,
    reconcileProfileId: null,
    unresolved: counts.unresolved,
  });
  return { ...resultOf(platform, error, counts), removed };
}

/** Unpublished artifact: keep ordinary members, but never strand an erasure/refusal cleanup. */
async function cleanupOnlyPlatform(
  db: Db,
  ws: string,
  syncId: string,
  platform: Platform,
  deps: AudienceSyncDeps,
  limit: number,
): Promise<SyncResult> {
  const errors: string[] = [];
  let removed = 0;
  const purposes = await db.withWorkspace(ws, async (tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES);
  const [state] = await db.withWorkspace(ws, (tx) =>
    tx
      .select({ destinationKey: schema.audienceSyncState.destinationKey })
      .from(schema.audienceSyncState)
      .where(
        and(
          eq(schema.audienceSyncState.workspaceId, ws),
          eq(schema.audienceSyncState.syncId, syncId),
          eq(schema.audienceSyncState.platform, platform),
        ),
      ),
  );
  const groups = await listDestinationGroups(db, ws, syncId, platform, null, MAX_PRIOR_DESTINATIONS);
  for (const group of groups) {
    const ref =
      group.destinationKnown && group.connectionId && group.destinationId && group.operatingAccountId !== null
        ? {
            platform,
            connectionId: group.connectionId,
            destinationId: group.destinationId,
            operatingAccountId: group.operatingAccountId,
            loginAccountId: group.loginAccountId,
          }
        : null;
    if (!ref) {
      await markDestinationOrphaned(db, ws, syncId, platform, group.destinationKey, 'uploaded before 0.7.4: destination was not recorded');
      errors.push(`${CLEANUP_PENDING_PREFIX} for ${group.rows} member(s): the destination was not recorded`);
      continue;
    }
    const loaded = await db.withWorkspace(ws, (tx) => loadConnection(tx, ref.connectionId, deps.kp));
    if (loaded.error) {
      await markDestinationOrphaned(db, ws, syncId, platform, group.destinationKey, `${CLEANUP_PENDING_PREFIX}: ${loaded.error}`);
      errors.push(`${CLEANUP_PENDING_PREFIX} for ${group.rows} member(s): ${loaded.error}`);
      continue;
    }
    const outcome = await cleanupOnlyDestination(
      db,
      ws,
      syncId,
      platform,
      ref,
      purposes,
      {
        ...deps,
        connection: loaded.conn!,
        secrets: loaded.secrets,
      },
      limit,
      state?.destinationKey ?? null,
    );
    removed += outcome.removed;
    errors.push(...outcome.errors);
  }
  const counts = await countsFor(db, ws, syncId, platform, null);
  const error = errors.length ? [...new Set(errors)].join('; ') : null;
  await saveState(db, ws, syncId, platform, {
    status: error ? 'error' : 'ok',
    error,
    members: counts.members,
    added: 0,
    removed,
    // Keep the last known current destination so a later cleanup-only run can confirm a
    // re-enabled destination and clear its orphan markers.
    destinationKey: state?.destinationKey ?? null,
    lastProfileId: null,
    reconcileProfileId: null,
    unresolved: counts.unresolved,
  });
  return { ...resultOf(platform, error, counts), removed };
}

async function fullPlatform(
  db: Db,
  ws: string,
  syncId: string,
  def: AudienceSync,
  platform: Platform,
  deps: AudienceSyncDeps,
): Promise<SyncResult> {
  const maxAdds = deps.maxAddsPerRun ?? MAX_ADDS_PER_RUN;
  const maxReconcile = deps.maxReconcilePerRun ?? MAX_RECONCILE_PER_RUN;
  const maxRemovals = deps.maxRemovalsPerRun ?? MAX_REMOVALS_PER_RUN;
  const maxPrior = deps.maxPriorPerRun ?? MAX_PRIOR_ROWS_PER_DESTINATION;
  const maxMerges = deps.maxMergesPerRun ?? MAX_MERGES_PER_RUN;
  const maxIntents = deps.maxIntentsPerRun ?? MAX_INTENTS_PER_RUN;
  const errors: string[] = [];
  const addError = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
  };

  const purposes = await db.withWorkspace(ws, async (tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES);
  const [state] = await db.withWorkspace(ws, (tx) =>
    tx
      .select()
      .from(schema.audienceSyncState)
      .where(
        and(
          eq(schema.audienceSyncState.workspaceId, ws),
          eq(schema.audienceSyncState.syncId, syncId),
          eq(schema.audienceSyncState.platform, platform),
        ),
      ),
  );

  let current: DestinationRef | null = null;
  let currentError: string | null = null;
  let loadedCurrent: LoadedConnection = { conn: null, secrets: {}, error: null };
  const ref = def[platform];
  if (ref) {
    loadedCurrent = await db.withWorkspace(ws, (tx) => loadConnection(tx, ref.connection, deps.kp));
    if (loadedCurrent.conn) {
      try {
        current = refFromCurrent(platform, def, loadedCurrent.conn);
      } catch (err) {
        currentError = `connection settings are unusable: ${audienceErrorText(err)}`;
      }
    }
    if (loadedCurrent.error) currentError = loadedCurrent.error;
  }
  const currentKey = current ? destinationKeyOf(current) : null;
  const removeLeavers = def.removals !== false;
  // If the artifact still targets this platform but its current destination cannot be resolved
  // (deleted connection, unusable settings), do not treat every stored row as a previous
  // destination: that could delete the live audience. Keep the known current destination and
  // surface its cleanup instead; only rows at other recorded destinations are evacuated.
  const currentUnresolved = !!ref && !current;
  const effectiveCurrentKey = currentKey ?? (ref ? (state?.destinationKey ?? null) : null);
  if ((currentUnresolved || currentError) && effectiveCurrentKey) {
    await markDestinationOrphaned(
      db,
      ws,
      syncId,
      platform,
      effectiveCurrentKey,
      `${CLEANUP_PENDING_PREFIX}: ${currentError ?? 'the current destination could not be resolved'}`,
    );
  }

  // 1. Previous destinations are removed first, using their recorded operating account (#400).
  const groups =
    currentUnresolved && !effectiveCurrentKey
      ? []
      : await listDestinationGroups(db, ws, syncId, platform, effectiveCurrentKey, MAX_PRIOR_DESTINATIONS);
  let removed = 0;
  for (const group of groups) {
    const groupRef =
      group.destinationKnown && group.connectionId && group.destinationId && group.operatingAccountId !== null
        ? {
            platform,
            connectionId: group.connectionId,
            destinationId: group.destinationId,
            operatingAccountId: group.operatingAccountId,
            loginAccountId: group.loginAccountId,
          }
        : null;
    if (!groupRef) {
      await markDestinationOrphaned(db, ws, syncId, platform, group.destinationKey, 'uploaded before 0.7.4: destination was not recorded');
      addError(`${CLEANUP_PENDING_PREFIX} for ${group.rows} member(s) uploaded before 0.7.4: their destination was not recorded`);
      continue;
    }
    const loaded = await db.withWorkspace(ws, (tx) => loadConnection(tx, groupRef.connectionId, deps.kp));
    if (loaded.error) {
      await markDestinationOrphaned(db, ws, syncId, platform, group.destinationKey, `${CLEANUP_PENDING_PREFIX}: ${loaded.error}`);
      addError(`${CLEANUP_PENDING_PREFIX} for ${group.rows} member(s): ${loaded.error}`);
      continue;
    }
    const outcome = await evacuateDestination(db, ws, syncId, platform, groupRef, maxPrior, {
      ...deps,
      connection: loaded.conn!,
      secrets: loaded.secrets,
    });
    removed += outcome.removed;
    for (const e of outcome.errors) addError(e);
  }

  // 2. The current destination.
  let added = 0;
  let nextAddCursor = state?.lastProfileId ?? null;
  let nextReconcileCursor = state?.reconcileProfileId ?? null;
  if (!current) {
    if (ref && !currentError) addError('the connection settings could not be read');
    else if (currentError) addError(currentError);
  } else if (currentError) {
    addError(currentError);
  } else {
    const currentDeps = { ...deps, connection: loadedCurrent.conn!, secrets: loadedCurrent.secrets };
    if (state?.destinationKey !== currentKey) {
      nextAddCursor = null;
      nextReconcileCursor = null;
    }
    const intents = await processCurrentIntents(db, ws, syncId, platform, def, current, purposes, currentDeps, {
      removeLeavers,
      limit: maxIntents,
    });
    added += intents.added;
    for (const e of intents.errors) addError(e);

    const merges = await processMergeRepair(db, ws, syncId, platform, current, currentDeps, def, purposes, maxMerges);
    for (const e of merges.errors) addError(e);

    const removals = await processRemovals(db, ws, syncId, platform, def, current, purposes, currentDeps, maxRemovals);
    removed += removals.removed;
    for (const e of removals.errors) addError(e);

    const reconcile = await processReconcile(
      db,
      ws,
      syncId,
      platform,
      def,
      current,
      purposes,
      nextReconcileCursor,
      currentDeps,
      maxReconcile,
    );
    added += reconcile.outcome.added;
    nextReconcileCursor = reconcile.next;
    for (const e of reconcile.outcome.errors) addError(e);

    const additions = await processAdditions(db, ws, syncId, platform, def, current, purposes, nextAddCursor, currentDeps, maxAdds);
    added += additions.outcome.added;
    nextAddCursor = additions.next;
    for (const e of additions.outcome.errors) addError(e);
  }

  const counts = await countsFor(db, ws, syncId, platform, currentKey);
  const unresolvedText =
    counts.unresolved > 0
      ? `${CLEANUP_PENDING_PREFIX} for ${counts.unresolved} member(s): finish the removal or acknowledge the legacy/manual cleanup with ads.acknowledgeAudienceCleanup`
      : null;
  const error = [...errors, unresolvedText].filter((e): e is string => !!e).join('; ') || null;
  await saveState(db, ws, syncId, platform, {
    status: error ? 'error' : 'ok',
    error,
    members: counts.members,
    added,
    removed,
    destinationKey: currentKey,
    lastProfileId: nextAddCursor,
    reconcileProfileId: nextReconcileCursor,
    unresolved: counts.unresolved,
  });
  if (error) logger.warn({ workspace: ws, sync: syncId, platform, error }, 'audience sync failed');
  return {
    platform,
    status: error ? 'error' : 'ok',
    added,
    removed,
    members: counts.members,
    unresolved: counts.unresolved,
    pending: counts.pending,
    error,
  };
}

async function syncPlatform(
  db: Db,
  ws: string,
  syncId: string,
  def: AudienceSync | null,
  platform: Platform,
  deps: AudienceSyncDeps,
  opts: SyncOptions,
): Promise<SyncResult> {
  if (!def || opts.removeAll)
    return removeAllPlatform(db, ws, syncId, platform, deps, deps.maxPriorPerRun ?? MAX_PRIOR_ROWS_PER_DESTINATION);
  if (opts.cleanupOnly) return cleanupOnlyPlatform(db, ws, syncId, platform, deps, deps.maxPriorPerRun ?? MAX_PRIOR_ROWS_PER_DESTINATION);
  return fullPlatform(db, ws, syncId, def, platform, deps);
}

/** Platforms and destination keys already recorded for a sync, including unpublished/deleted ones. */
async function storedAudienceState(db: Db, ws: string, syncId: string): Promise<{ platforms: Platform[]; targets: string[] }> {
  return db.withWorkspace(ws, async (tx) => {
    const { rows } = await tx.execute<{
      platform: Platform;
      operating_account_id: string | null;
      login_account_id: string | null;
      destination_id: string | null;
    }>(sql`
      SELECT platform, operating_account_id, login_account_id, destination_id
      FROM audience_members WHERE workspace_id = ${ws} AND sync_id = ${syncId}
      UNION
      SELECT platform, operating_account_id, login_account_id, destination_id
      FROM audience_write_intents WHERE workspace_id = ${ws} AND sync_id = ${syncId}
      UNION
      SELECT platform, NULL AS operating_account_id, NULL AS login_account_id, NULL AS destination_id
      FROM audience_sync_state WHERE workspace_id = ${ws} AND sync_id = ${syncId}`);
    const targets = rows
      .filter((r) => r.operating_account_id !== null && r.destination_id !== null)
      .map((r) =>
        remoteTargetKeyOf({
          platform: r.platform,
          connectionId: '',
          operatingAccountId: r.operating_account_id!,
          loginAccountId: r.login_account_id,
          destinationId: r.destination_id!,
        }),
      );
    return { platforms: [...new Set(rows.map((r) => r.platform))], targets: [...new Set(targets)] };
  });
}

async function withAudienceLocks<T>(db: Db, keys: string[], fn: () => Promise<T>): Promise<T | null> {
  const client = await db.admin.connect();
  const acquired: string[] = [];
  let destroy = false;
  try {
    for (const key of [...new Set(keys)].sort()) {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked', [
        key,
      ]);
      if (!rows[0]?.locked) return null;
      acquired.push(key);
    }
    return await fn();
  } finally {
    for (const key of acquired.reverse())
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [key]).catch((err: unknown) => {
        destroy = true;
        logger.warn({ key, err }, 'audience lock release failed');
      });
    client.release(destroy);
  }
}

/**
 * One reconcile of one audience sync, for each platform it targets or used to target. Runs that
 * share a remote destination (or the same sync) are serialized with session advisory locks on a
 * dedicated admin connection, so a removal in one sync cannot delete another sync's valid member.
 * No HTTP happens inside a database transaction.
 */
export async function syncAudience(
  db: Db,
  ws: string,
  syncId: string,
  def: AudienceSync | null,
  deps: AudienceSyncDeps,
  opts: SyncOptions = {},
): Promise<SyncResult[]> {
  const stored = await storedAudienceState(db, ws, syncId);
  const platforms = new Set<Platform>(stored.platforms);
  if (def && !opts.removeAll) for (const platform of ['meta', 'google'] as const) if (def[platform]) platforms.add(platform);
  if (!platforms.size) return [];

  const keys = [`audience-sync:${ws}:${syncId}`, ...stored.targets.map((k) => `audience-target:${ws}:${k}`)];
  if (def && !opts.removeAll) {
    const currentTargets = await db.withWorkspace(ws, async (tx) => {
      const out: string[] = [];
      for (const platform of ['meta', 'google'] as const) {
        const ref = def[platform];
        if (!ref) continue;
        const loaded = await loadConnection(tx, ref.connection, deps.kp);
        if (!loaded.conn) continue;
        try {
          const destination = refFromCurrent(platform, def, loaded.conn);
          if (destination) out.push(remoteTargetKeyOf(destination));
        } catch {
          // The platform run reports the unusable settings; no key can be locked.
        }
      }
      return out;
    });
    keys.push(...currentTargets.map((k) => `audience-target:${ws}:${k}`));
  }

  const results = await withAudienceLocks(db, keys, async () => {
    const out: SyncResult[] = [];
    for (const platform of platforms) {
      try {
        out.push(await syncPlatform(db, ws, syncId, def, platform, deps, opts));
      } catch (err) {
        const message = audienceErrorText(err);
        logger.error({ workspace: ws, sync: syncId, platform, err }, 'audience platform sync failed');
        out.push(resultOf(platform, message));
      }
    }
    return out;
  });
  if (results) return results;
  logger.info({ workspace: ws, sync: syncId }, 'audience sync already running; skipping this run');
  return [...platforms].map((platform) => resultOf(platform, 'skipped: another sync of this audience or destination is already running'));
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

async function definitionFor(
  db: Db,
  ws: string,
  syncId: string,
): Promise<{ def: AudienceSync | null; published: boolean; exists: boolean }> {
  return db.withWorkspace(ws, async (tx) => {
    const [artifact] = await tx
      .select({ publishedVersion: schema.artifacts.publishedVersion })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, syncId), eq(schema.artifacts.type, 'audience_sync')));
    if (!artifact) return { def: null, published: false, exists: false };
    if (artifact.publishedVersion !== null) {
      const [v] = await tx
        .select({ content: schema.artifactVersions.content })
        .from(schema.artifactVersions)
        .where(
          and(
            eq(schema.artifactVersions.workspaceId, ws),
            eq(schema.artifactVersions.artifactId, syncId),
            eq(schema.artifactVersions.number, artifact.publishedVersion),
          ),
        );
      return { def: (v?.content as AudienceSync | undefined) ?? null, published: true, exists: true };
    }
    const { rows } = await tx.execute<{ content: unknown }>(sql`
      SELECT content FROM artifact_versions
      WHERE workspace_id = ${ws} AND artifact_id = ${syncId}
      ORDER BY number DESC LIMIT 1`);
    return { def: (rows[0]?.content as AudienceSync | undefined) ?? null, published: false, exists: true };
  });
}

/**
 * One scheduler pass. Every sync is isolated: one poisoned sync (for example a huge legacy
 * destination) is logged and the rest of the round still runs. Published artifacts get a full
 * reconcile; unpublished or deleted ones still get erasure/refusal cleanup and intent recovery.
 */
// Fair bounded scans across ticks, including poisoned entries; a scheduler restart starts a new pass.
const roundCursors = new WeakMap<Db, { workspace_id: string; sync_id: string }>();

export async function selectAudienceSyncRound(db: Db, limit = MAX_SYNCS_PER_ROUND): Promise<{ workspace_id: string; sync_id: string }[]> {
  const after = roundCursors.get(db);
  const { rows } = await db.admin.query<{ workspace_id: string; sync_id: string }>(
    `WITH candidates AS (
       SELECT workspace_id, id AS sync_id FROM artifacts WHERE type = 'audience_sync' AND published_version IS NOT NULL
       UNION SELECT DISTINCT workspace_id, sync_id FROM audience_members
       UNION SELECT DISTINCT workspace_id, sync_id FROM audience_write_intents
       UNION SELECT workspace_id, sync_id FROM audience_sync_state
     ) SELECT workspace_id, sync_id FROM candidates
     WHERE $1::uuid IS NULL OR (workspace_id, sync_id) > ($1::uuid, $2::text)
     ORDER BY workspace_id, sync_id LIMIT ${Math.max(1, Math.min(limit, MAX_SYNCS_PER_ROUND))}`,
    [after?.workspace_id ?? null, after?.sync_id ?? null],
  );
  if (rows.length) roundCursors.set(db, rows[rows.length - 1]!);
  else roundCursors.delete(db);
  return rows;
}

export async function runAudienceSyncRound(deps: {
  db: Db;
  kp: KeyProvider;
  egress: EgressPolicy;
}): Promise<{ syncs: number; failures: number }> {
  let rows = await selectAudienceSyncRound(deps.db);
  if (!rows.length) rows = await selectAudienceSyncRound(deps.db);
  let failures = 0;
  for (const row of rows) {
    try {
      const meta = await definitionFor(deps.db, row.workspace_id, row.sync_id);
      await syncAudience(deps.db, row.workspace_id, row.sync_id, meta.def, deps, {
        cleanupOnly: !meta.published,
        removeAll: !meta.exists,
      });
    } catch (err) {
      failures++;
      logger.error({ workspace: row.workspace_id, sync: row.sync_id, err }, 'audience sync round entry failed');
    }
  }
  return { syncs: rows.length, failures };
}

/** Scheduler role: reconciles every audience sync, every 15 minutes. */
export async function runAudienceSyncs(deps: { db: Db; kp: KeyProvider; egress: EgressPolicy }, signal: AbortSignal, tickMs = 900_000) {
  while (!signal.aborted) {
    try {
      await runAudienceSyncRound(deps);
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
  unresolved: z.number().int().describe('Orphaned rows/intents that still need a removal or acknowledgement'),
  pending: z.number().int().describe('Durable remote writes whose ledger row is not confirmed yet'),
  error: z.string().nullable(),
});

const CleanupOut = z.object({
  syncId: z.string(),
  platform: z.enum(['meta', 'google']),
  status: z.enum(['ok', 'error']),
  members: z.number().int(),
  unresolved: z.number().int(),
  pending: z.number().int(),
  error: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  destinationKey: z.string().nullable(),
});

export const listAudiences = defineCommand({
  name: 'ads.audiences',
  title: 'Audience syncs and their state',
  description:
    'Published audience syncs (segment → Meta custom audience / Google Customer Match list) with how many people are synced, the last run, unresolved cleanup and its error. Also lists cleanup owed by unpublished or deleted syncs, so erasure/refusal obligations remain visible. Members are people in the segment who allowed ad_targeting and have an e-mail or phone.',
  input: z.object({ cleanupAfter: z.string().optional() }),
  output: z.object({
    audiences: z.array(
      z.object({ id: z.string(), segment: z.string(), platforms: z.array(SyncOut.extend({ lastRunAt: z.string().nullable() })) }),
    ),
    cleanup: z.array(CleanupOut),
    cleanupNext: z.string().nullable(),
    cleanupTotal: z.number().int(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async ({ cleanupAfter }, ctx) => {
    const syncs = await publishedSyncs(ctx.tx);
    const states = await ctx.tx.select().from(schema.audienceSyncState);
    const published = new Set(syncs.map((s) => s.id));
    const counts = new Map<string, { members: number; unresolved: number; pending: number }>();
    const { rows } = await ctx.tx.execute<{
      sync_id: string;
      platform: Platform;
      members: number;
      orphaned: number;
      pending: number;
      orphaned_intents: number;
    }>(sql`
      SELECT m.sync_id, m.platform,
             count(*) FILTER (WHERE s.destination_key IS NULL OR m.destination_key = s.destination_key)::int AS members,
             count(*) FILTER (WHERE NOT m.destination_known OR m.orphaned_at IS NOT NULL)::int AS orphaned,
             coalesce(i.pending, 0)::int AS pending,
             coalesce(i.orphaned, 0)::int AS orphaned_intents
      FROM audience_members m
      LEFT JOIN audience_sync_state s
        ON s.workspace_id = m.workspace_id AND s.sync_id = m.sync_id AND s.platform = m.platform
      LEFT JOIN (
        SELECT sync_id, platform, count(*)::int AS pending, count(*) FILTER (WHERE orphaned_at IS NOT NULL)::int AS orphaned
        FROM audience_write_intents GROUP BY sync_id, platform
      ) i ON i.sync_id = m.sync_id AND i.platform = m.platform
      GROUP BY m.sync_id, m.platform, s.destination_key, i.pending, i.orphaned
      UNION ALL
      SELECT i.sync_id, i.platform, 0 AS members, 0 AS orphaned,
             count(*)::int AS pending, count(*) FILTER (WHERE orphaned_at IS NOT NULL)::int AS orphaned_intents
      FROM audience_write_intents i
      WHERE NOT EXISTS (
        SELECT 1 FROM audience_members m WHERE m.sync_id = i.sync_id AND m.platform = i.platform)
      GROUP BY i.sync_id, i.platform`);
    for (const row of rows) {
      counts.set(`${row.sync_id}:${row.platform}`, {
        members: row.members,
        unresolved: row.orphaned + row.pending,
        pending: row.pending,
      });
    }
    const cleanup: z.output<typeof CleanupOut>[] = [];
    const cleanupSyncIds = [...new Set([...states.map((s) => s.syncId), ...rows.map((r) => r.sync_id)])]
      .filter((id) => !published.has(id))
      .sort();
    const cleanupPage = cleanupSyncIds.filter((id) => !cleanupAfter || id > cleanupAfter).slice(0, MAX_BACKLOG_PAGE + 1);
    for (const syncId of cleanupPage.slice(0, MAX_BACKLOG_PAGE)) {
      for (const platform of ['meta', 'google'] as const) {
        const st = states.find((x) => x.syncId === syncId && x.platform === platform);
        const c = counts.get(`${syncId}:${platform}`);
        if (!st && !c) continue;
        cleanup.push({
          syncId,
          platform,
          status: st?.status === 'error' || (c?.unresolved ?? 0) > 0 ? 'error' : 'ok',
          members: c?.members ?? st?.members ?? 0,
          unresolved: c?.unresolved ?? st?.unresolved ?? 0,
          pending: c?.pending ?? 0,
          error: st?.error ?? null,
          lastRunAt: st?.lastRunAt.toISOString() ?? null,
          destinationKey: st?.destinationKey ?? null,
        });
      }
    }
    return {
      audiences: syncs.map((s) => ({
        id: s.id,
        segment: s.def.segment,
        platforms: (['meta', 'google'] as const)
          .filter((p) => {
            if (s.def[p]) return true;
            const st = states.find((x) => x.syncId === s.id && x.platform === p);
            return !!st && (st.status === 'error' || st.members > 0 || st.unresolved > 0);
          })
          .map((p) => {
            const st = states.find((x) => x.syncId === s.id && x.platform === p);
            const c = counts.get(`${s.id}:${p}`);
            const unresolved = c?.unresolved ?? st?.unresolved ?? 0;
            return {
              platform: p,
              status: st?.status === 'error' || unresolved > 0 ? ('error' as const) : ('ok' as const),
              added: st?.added ?? 0,
              removed: st?.removed ?? 0,
              members: c?.members ?? st?.members ?? 0,
              unresolved,
              pending: c?.pending ?? 0,
              error: st?.error ?? null,
              lastRunAt: st?.lastRunAt.toISOString() ?? null,
            };
          }),
      })),
      cleanup,
      cleanupNext: cleanupPage.length > MAX_BACKLOG_PAGE ? cleanupPage[MAX_BACKLOG_PAGE - 1]! : null,
      cleanupTotal: cleanupSyncIds.length,
    };
  },
});

const CleanupId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'A cleanup id from ads.audienceBacklog');

export const audienceBacklog = defineCommand({
  name: 'ads.audienceBacklog',
  title: 'Inspect audience cleanups',
  description:
    'Audience rows and durable intents whose remote removal is still owed, ordered by cleanup id and pageable with `after`. Entries name the sync, platform, destination and reason, never raw hashes or profile ids. A person completes the removal out of band (for example for pre-0.7.4 rows whose destination was never recorded) and acknowledges selected ids with ads.acknowledgeAudienceCleanup.',
  input: z.object({
    syncId: z
      .string()
      .regex(/^aud_[0-9a-f]{32}$/)
      .optional()
      .describe('Only this audience sync'),
    after: CleanupId.optional().describe('Last cleanup id of the previous page'),
    limit: z.number().int().min(1).max(MAX_BACKLOG_PAGE).default(50),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        cleanupId: z.string(),
        syncId: z.string(),
        platform: z.enum(['meta', 'google']),
        kind: z.enum(['member', 'intent']),
        destinationKey: z.string(),
        reason: z.string().nullable(),
        attempts: z.number().int(),
        lastError: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
    next: z.string().nullable(),
    total: z.number().int(),
  }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async ({ syncId, after, limit }, ctx) => {
    const ws = ctx.principal.workspaceId;
    const filter = syncId ? sql`AND sync_id = ${syncId}` : sql``;
    const afterFilter = after ? sql`AND cleanup_id > ${after}::uuid` : sql``;
    const { rows } = await ctx.tx.execute<{
      cleanup_id: string;
      sync_id: string;
      platform: Platform;
      kind: 'member' | 'intent';
      destination_key: string;
      reason: string | null;
      attempts: number;
      last_error: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(sql`
      SELECT cleanup_id::text, sync_id, platform, 'member'::text AS kind, destination_key,
             orphaned_reason AS reason, attempts, last_error, added_at AS created_at, updated_at
      FROM audience_members
      WHERE workspace_id = ${ws} AND orphaned_at IS NOT NULL ${filter} ${afterFilter}
      UNION ALL
      SELECT cleanup_id::text, sync_id, platform, 'intent'::text AS kind, destination_key,
             orphaned_reason AS reason, attempts, last_error, created_at, updated_at
      FROM audience_write_intents
      WHERE workspace_id = ${ws} AND orphaned_at IS NOT NULL ${filter} ${afterFilter}
      ORDER BY cleanup_id
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const { rows: totals } = await ctx.tx.execute<{ n: number }>(sql`
      SELECT (
        (SELECT count(*) FROM audience_members WHERE workspace_id = ${ws} AND orphaned_at IS NOT NULL ${filter}) +
        (SELECT count(*) FROM audience_write_intents WHERE workspace_id = ${ws} AND orphaned_at IS NOT NULL ${filter})
      )::int AS n`);
    return {
      entries: page.map((r) => ({
        cleanupId: r.cleanup_id,
        syncId: r.sync_id,
        platform: r.platform,
        kind: r.kind,
        destinationKey: r.destination_key,
        reason: r.reason,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      next: rows.length > limit ? page[page.length - 1]!.cleanup_id : null,
      total: totals[0]?.n ?? 0,
    };
  },
});

export const acknowledgeAudienceCleanup = defineCommand({
  name: 'ads.acknowledgeAudienceCleanup',
  title: 'Acknowledge manual audience cleanups',
  description:
    "Record that a person finished the manual removal for selected audience cleanup ids. Only the named orphaned rows/intents are removed; the sync id and a hash of the complete input (including the note) are audited, and the note text is not retained. This never sends a request to an ad platform and never acknowledges a row that is not in this sync's backlog.",
  input: z.object({
    syncId: z.string().regex(/^aud_[0-9a-f]{32}$/),
    cleanupIds: z.array(CleanupId).min(1).max(MAX_BACKLOG_PAGE),
    note: z.string().trim().min(1).max(2000).describe('What was cleaned up, where and by whom'),
  }),
  output: z.object({ acknowledged: z.number().int(), remaining: z.number().int() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.syncId,
  handler: async ({ syncId, cleanupIds }, ctx) => {
    const ws = ctx.principal.workspaceId;
    const selected = [...new Set(cleanupIds)];
    // Serialize with a run of the same sync (same advisory key), so a late run cannot re-add what
    // a person just acknowledged.
    await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audience-sync:${ws}:${syncId}`}, 0))`);
    const { rows } = await ctx.tx.execute<{ cleanup_id: string; kind: string }>(sql`
      SELECT cleanup_id::text, 'member'::text AS kind FROM audience_members
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND orphaned_at IS NOT NULL
        AND cleanup_id = ANY(${sql.param(selected)}::uuid[])
      UNION ALL
      SELECT cleanup_id::text, 'intent'::text AS kind FROM audience_write_intents
      WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND orphaned_at IS NOT NULL
        AND cleanup_id = ANY(${sql.param(selected)}::uuid[])`);
    if (rows.length !== selected.length) {
      const found = new Set(rows.map((r) => r.cleanup_id));
      throw new AppError(
        'not_found',
        `Not in this sync's audience backlog: ${selected.filter((id) => !found.has(id)).join(', ')}. Inspect it with ads.audienceBacklog.`,
      );
    }
    const deletedMembers = await ctx.tx
      .delete(schema.audienceMembers)
      .where(
        and(
          eq(schema.audienceMembers.workspaceId, ws),
          eq(schema.audienceMembers.syncId, syncId),
          inArray(schema.audienceMembers.cleanupId, selected),
        ),
      )
      .returning({ id: schema.audienceMembers.cleanupId });
    const deletedIntents = await ctx.tx
      .delete(schema.audienceWriteIntents)
      .where(
        and(
          eq(schema.audienceWriteIntents.workspaceId, ws),
          eq(schema.audienceWriteIntents.syncId, syncId),
          inArray(schema.audienceWriteIntents.cleanupId, selected),
        ),
      )
      .returning({ id: schema.audienceWriteIntents.cleanupId });
    const states = await ctx.tx
      .select()
      .from(schema.audienceSyncState)
      .where(and(eq(schema.audienceSyncState.workspaceId, ws), eq(schema.audienceSyncState.syncId, syncId)));
    let remaining = 0;
    for (const st of states) {
      const counts = await ctx.tx.execute<{ n: number }>(sql`
        SELECT (
          (SELECT count(*) FROM audience_members
           WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${st.platform}
             AND (NOT destination_known OR orphaned_at IS NOT NULL)) +
          (SELECT count(*) FROM audience_write_intents
           WHERE workspace_id = ${ws} AND sync_id = ${syncId} AND platform = ${st.platform})
        )::int AS n`);
      const n = counts.rows[0]?.n ?? 0;
      remaining += n;
      await ctx.tx
        .update(schema.audienceSyncState)
        .set({
          unresolved: n,
          ...(n === 0 && st.error?.startsWith(CLEANUP_PENDING_PREFIX) ? { status: 'ok' as const, error: null } : {}),
        })
        .where(
          and(
            eq(schema.audienceSyncState.workspaceId, ws),
            eq(schema.audienceSyncState.syncId, syncId),
            eq(schema.audienceSyncState.platform, st.platform),
          ),
        );
    }
    return { acknowledged: deletedMembers.length + deletedIntents.length, remaining };
  },
});

export const retryAudienceCleanup = defineCommand({
  name: 'ads.retryAudienceCleanup',
  title: 'Retry audience cleanup now',
  description:
    'Retries erasure/refusal cleanup and durable-intent recovery for one audience sync, including an unpublished or deleted artifact. It never adds new members; use ads.syncAudience for a published sync. Unreachable destinations stay visible instead of being reported as cleaned.',
  input: z.object({ syncId: z.string().regex(/^aud_[0-9a-f]{32}$/) }),
  output: z.object({ results: z.array(SyncOut) }),
  permission: 'messages:send',
  effect: 'write',
  actionClass: 'audience.publish',
  target: (i) => i.syncId,
  handler: async (input, ctx) => {
    if (!ctx.services.db) throw new AppError('conflict', 'Audience cleanup needs the database service.');
    const ws = ctx.principal.workspaceId;
    const meta = await definitionFor(ctx.services.db, ws, input.syncId);
    const stored = await storedAudienceState(ctx.services.db, ws, input.syncId);
    if (!meta.exists && !stored.platforms.length) throw new AppError('not_found', `${input.syncId} has no audience sync or cleanup state.`);
    return {
      results: await syncAudience(
        ctx.services.db,
        ws,
        input.syncId,
        meta.def,
        { kp: ctx.services.keyProvider, egress: ctx.services.egress ?? { allowedHosts: [] } },
        { cleanupOnly: true, removeAll: !meta.exists },
      ),
    };
  },
});

export const runAudienceSync = defineCommand({
  name: 'ads.syncAudience',
  title: 'Sync an audience now',
  description:
    'Reconciles one published audience sync right away instead of waiting for the next run (every 15 minutes). Sends hashed identifiers to the platforms. Cleanup for an unpublished or deleted sync uses ads.retryAudienceCleanup.',
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

export const adAudienceCommands = [
  listAudiences,
  runAudienceSync,
  audienceBacklog,
  acknowledgeAudienceCleanup,
  retryAudienceCleanup,
] as const;
