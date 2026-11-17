import { randomUUID } from 'node:crypto';
import { MERGE_MAX_HOPS, mergeComponentCtes } from '@agentic-marketing/artifacts';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, sql } from 'drizzle-orm';

// One identity resolution for campaign conversions (#590).
//
// ClickHouse keeps the profile id an event had when it was stored. A merge does not rewrite it,
// but identifiers do follow the merge survivor, so a merge can make an event and the recipient it
// belongs to carry different profile ids. Both surfaces resolve an event through the same map, so
// a merge cannot make one count and the other not.
//
// The map holds every key whose resolution differs from the event's stored profile id: a profile
// that was merged away, and the anonymous ids / user ids that moved to its survivor. A profile
// that was never merged cannot differ, because ingest stores the profile id it resolved.
//
// A campaign-scoped map (the campaign measures and the holdout) is built from the recipients and
// their merge component, so it is bounded by the campaign rather than by every merge in the
// workspace. Scoping is also what keeps unrelated workspace growth from silently changing the
// headline: the map is all-or-nothing at its bound, and the bound is the largest campaign the
// platform supports.

export type IdentityKind = 'anonymous_id' | 'user_id' | 'profile';

export interface IdentityPair {
  /** The historical key: an identifier value, or a merged-away profile id. */
  key: string;
  /** The profile that key currently resolves to. */
  profileId: string;
  kind: IdentityKind;
}

export interface IdentityMap {
  /** Every key and the profile it resolves to. The map is complete in-process. */
  pairs: IdentityPair[];
  /**
   * True when the map is larger than the transport bound. A caller that ships the map must then
   * ship none of it (never a partial one) and report that the result is not identity-resolved.
   */
  overLimit: boolean;
  limit: number;
}

/**
 * The largest audience the platform supports in one campaign send: `journeys.enrollSegment` caps
 * a backfill at 100,000 people, the one explicit audience-size limit a campaign can inherit
 * (broadcasts use the same segment and send gateway in batches of 200).
 */
export const MAX_CAMPAIGN_RECIPIENTS = 100_000;

/**
 * At most this many pairs travel to ClickHouse as parameter arrays. The bound is stated in pairs,
 * not recipients: one recipient can contribute more than three pairs (several anonymous ids,
 * several user ids, a merged-away profile and its merge ancestors), so a per-recipient multiplier
 * would understate the map. A campaign-scoped map cannot exceed it through unrelated workspace
 * growth, because scoping happens before the bound is applied.
 */
export const IDENTITY_MAP_LIMIT = 300_000;

/**
 * The byte bound that goes with the pair bound: at 36-character ids the worst case is
 * 300,000 * (36 + 36 + 8) = 24,000,000 bytes. Params above the URL budget travel in the multipart
 * body (`use_multipart_params_auto`), which is bounded by request size rather than by count.
 */
export const IDENTITY_MAP_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The most distinct recipient profile ids one campaign-scoped identity lookup reads. Reading one
 * more id than `IDENTITY_MAP_LIMIT` is enough to prove the map would exceed its pair bound: each id
 * can contribute at least one pair, so above the bound resolution is skipped rather than attempted.
 * The cap is in ids only for this Postgres read; the map's own bound is in pairs and bytes above.
 */
export const IDENTITY_SCOPE_PROFILE_LIMIT = IDENTITY_MAP_LIMIT;

/**
 * The scope row cap, overridable in tests so the over-bound path does not need 300,000 rows. The
 * value is read per call; production never sets it.
 */
export function identityScopeProfileLimit(): number {
  const override = Number(process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT);
  return Number.isInteger(override) && override > 0 ? override : IDENTITY_SCOPE_PROFILE_LIMIT;
}

/**
 * The traversal bound for one campaign's merge-component expansion (#1015 review). It is separate
 * from the mapping bound: a component member that was never merged away contributes no mapping, so
 * a survivor with many aliases must not spend the mapping bound. It still caps the work and the
 * memory of the expansion; above it resolution is skipped like any other over-limit load.
 */
export const IDENTITY_COMPONENT_PROFILE_LIMIT = 2 * IDENTITY_MAP_LIMIT;

/** Identifier rows per cursor fetch while the map is built, so the byte check can stop a load. */
const IDENTITY_IDENTIFIER_PAGE = 1_000;

/** The all-or-nothing map a caller ships when resolution was skipped at the bound. */
export const overLimitIdentityMap = (limit = IDENTITY_MAP_LIMIT): IdentityMap => ({ pairs: [], overLimit: true, limit });

/**
 * ClickHouse rejects an HTTP form field longer than `http_max_field_value_size` (128 KiB on the
 * supported version), so a shipped array is split across several fields below that limit. This is
 * the per-field budget, not the bound on the map: the map's total size is bounded above.
 */
export const IDENTITY_FIELD_BYTES = 120 * 1024;

export const emptyIdentityMap = (): IdentityMap => ({ pairs: [], overLimit: false, limit: IDENTITY_MAP_LIMIT });

/**
 * Deduplicates the pairs by kind and key and applies the transport bound. Exported for its test.
 * `maxBytes` is injectable so the bound can be exercised without allocating 32 MiB of keys.
 */
export function identityMapOf(pairs: readonly IdentityPair[], limit = IDENTITY_MAP_LIMIT, maxBytes = IDENTITY_MAP_MAX_BYTES): IdentityMap {
  const unique = new Map<string, IdentityPair>();
  for (const pair of pairs) {
    // A key that already resolves to itself changes nothing and would only spend the bound.
    if (!pair.key || !pair.profileId || pair.key === pair.profileId) continue;
    // Keep the first pair for a key: merge entries are added before identifiers, and a duplicate
    // key must not appear twice in the ClickHouse join (it would duplicate conversion rows).
    const id = `${pair.kind}:${pair.key}`;
    if (!unique.has(id)) unique.set(id, pair);
  }
  const all = [...unique.values()];
  const bytes = all.reduce((n, p) => n + Buffer.byteLength(p.key) + Buffer.byteLength(p.profileId) + 8, 0);
  // A single key longer than one form field cannot be split, so it makes the map unshippable
  // rather than letting ClickHouse reject the query.
  const oversized = all.some(
    (p) =>
      Buffer.byteLength(JSON.stringify(p.key)) + 2 > IDENTITY_FIELD_BYTES ||
      Buffer.byteLength(JSON.stringify(p.profileId)) + 2 > IDENTITY_FIELD_BYTES,
  );
  return { pairs: all, overLimit: all.length > limit || bytes > maxBytes || oversized, limit };
}

/**
 * The one note a surface shows when it cannot resolve identity. The headline and the holdout use
 * the same sentence so an operator never sees two different explanations for the same omission.
 */
export function identityUnresolvedNote(limit: number): string {
  return `Conversions are not identity-resolved: this campaign's recipients have more than ${limit} identity mappings (a merged-away profile or an identifier that moved), so they are matched on the profile id stored with the event.`;
}

/** Profile ids per Postgres `inArray`; a large campaign must not exceed the parameter limit. */
const PROFILE_ID_CHUNK = 10_000;

/**
 * Every key whose identity differs from the stored event profile id, or, when `profileIds` is
 * set, every merge and identifier in those profiles' merge components. The workspace always comes
 * from the caller's transaction.
 *
 * Both reads are bounded (#986, #1015 review): the merge component is expanded from the campaign's
 * people only (never the workspace's whole merge list), the forward walk and the expansion stop at
 * their traversal bound, and identifiers are read through a cursor in pages whose byte cost is
 * checked as they arrive. The traversal bound is separate from the mapping bound — a survivor with
 * many aliases contributes no mapping for itself — and the mapping bound applies only to the pairs
 * that would ship. Any over-bound load returns the existing over-limit result, so a surface reports
 * the shared note instead of holding a partial map. `limit` and `maxBytes` are injectable so the
 * over-bound paths can be exercised without 300,000 rows or 32 MiB of keys.
 */
export async function loadIdentityMap(
  tx: Tx,
  workspaceId: string,
  opts: { profileIds?: readonly string[]; limit?: number; maxBytes?: number } = {},
): Promise<IdentityMap> {
  const limit = opts.limit ?? IDENTITY_MAP_LIMIT;
  const maxBytes = opts.maxBytes ?? IDENTITY_MAP_MAX_BYTES;
  const scope = opts.profileIds ? [...new Set(opts.profileIds)] : undefined;
  if (scope && !scope.length) return emptyIdentityMap();
  if (scope && scope.length > limit) return overLimitIdentityMap(limit);

  // Without a scope the merged profiles are the seeds; that read is bounded as well, so an
  // unscoped caller cannot load the workspace's merge list before checking the bound.
  let seeds = scope;
  if (!seeds) {
    const merged = await tx
      .select({ id: schema.profiles.id })
      .from(schema.profiles)
      .where(and(eq(schema.profiles.workspaceId, workspaceId), sql`${schema.profiles.mergedInto} IS NOT NULL`))
      .limit(limit + 1);
    if (merged.length > limit) return overLimitIdentityMap(limit);
    seeds = merged.map((row) => row.id);
  }
  if (!seeds.length) return emptyIdentityMap();

  // One representative per seed through the same bounded walk the holdout send and report use
  // (#985). A chain past the walk bound is corrupt; resolution is skipped rather than following it.
  const representatives = await tx.execute<{ representative: string; truncated: boolean }>(sql`
    WITH RECURSIVE ${mergeComponentCtes(workspaceId, {
      seeds: sql`SELECT DISTINCT unnest(${sql.param(seeds)}::text[]) AS id`,
    })}
    SELECT DISTINCT representative, truncated FROM merge_representative`);
  if (representatives.rows.some((row) => row.truncated)) return overLimitIdentityMap(limit);
  const reps = [...new Set(representatives.rows.map((row) => row.representative))];
  if (!reps.length) return emptyIdentityMap();

  // The whole component around those representatives, one row per connected profile, capped by its
  // own traversal bound. The `depth` rows at the walk bound mean the component is corrupt-deep.
  const component = await tx.execute<{ representative: string; profile_id: string; merged_into: string | null; depth: number }>(sql`
    WITH RECURSIVE ${mergeComponentCtes(workspaceId, {
      componentOf: sql`SELECT DISTINCT unnest(${sql.param(reps)}::text[]) AS rep`,
    })}
    SELECT mc.representative, mc.profile_id, p.merged_into, mc.depth
    FROM merge_component mc
    LEFT JOIN profiles p ON p.workspace_id = ${workspaceId} AND p.id = mc.profile_id
    LIMIT ${IDENTITY_COMPONENT_PROFILE_LIMIT + 1}`);
  if (component.rows.length > IDENTITY_COMPONENT_PROFILE_LIMIT) return overLimitIdentityMap(limit);
  if (component.rows.some((row) => row.depth >= MERGE_MAX_HOPS)) return overLimitIdentityMap(limit);

  // The map's bound is spent by the mappings it will ship, not by component rows: an unmerged
  // survivor contributes no pair. Both the pair and the byte bound are checked as pairs arrive.
  const pairs: IdentityPair[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const add = (pair: IdentityPair): boolean => {
    // The same rules identityMapOf applies, so stopping early can never disagree with it.
    if (!pair.key || !pair.profileId || pair.key === pair.profileId) return true;
    const id = `${pair.kind}:${pair.key}`;
    if (seen.has(id)) return true;
    const size = Buffer.byteLength(pair.key) + Buffer.byteLength(pair.profileId) + 8;
    const oversized =
      Buffer.byteLength(JSON.stringify(pair.key)) + 2 > IDENTITY_FIELD_BYTES ||
      Buffer.byteLength(JSON.stringify(pair.profileId)) + 2 > IDENTITY_FIELD_BYTES;
    if (pairs.length + 1 > limit || bytes + size > maxBytes || oversized) return false;
    seen.add(id);
    bytes += size;
    pairs.push(pair);
    return true;
  };

  const personOf = new Map<string, string>();
  for (const row of component.rows) {
    personOf.set(row.profile_id, row.representative);
    // A merged-away profile resolves to its person; an unmerged one already is their own profile.
    if (row.merged_into !== null && !add({ key: row.profile_id, profileId: row.representative, kind: 'profile' }))
      return overLimitIdentityMap(limit);
  }

  // Merging re-points identifiers to the survivor, so every component member is an owner to look
  // at. A cursor fetches them in bounded pages, so a survivor with many long identifiers stops at
  // the bound instead of being loaded first and rejected afterwards.
  const owners = [...personOf.keys()];
  for (let i = 0; i < owners.length; i += PROFILE_ID_CHUNK) {
    const cursor = sql.raw(`identity_ids_${randomUUID().replaceAll('-', '')}`);
    await tx.execute(sql`DECLARE ${cursor} NO SCROLL CURSOR FOR
      SELECT type, value, profile_id FROM identifiers
      WHERE workspace_id = ${workspaceId}
        AND type IN ('anonymous_id', 'user_id')
        AND profile_id = ANY(${sql.param(owners.slice(i, i + PROFILE_ID_CHUNK))}::text[])`);
    try {
      for (;;) {
        const page = Math.max(1, Math.min(IDENTITY_IDENTIFIER_PAGE, limit - pairs.length + 1));
        const fetched = await tx.execute<{ type: string; value: string; profile_id: string }>(
          sql`FETCH FORWARD ${sql.raw(String(page))} FROM ${cursor}`,
        );
        for (const identifier of fetched.rows) {
          const added = add({
            key: identifier.value,
            profileId: personOf.get(identifier.profile_id) ?? identifier.profile_id,
            // The query only selects the two identifier kinds the event store can resolve an event by.
            kind: identifier.type as IdentityKind,
          });
          if (!added) return overLimitIdentityMap(limit);
        }
        if (fetched.rows.length < page) break;
      }
    } finally {
      // A committed transaction closes it anyway; closing here keeps the bound honest on the way out.
      await tx.execute(sql`CLOSE ${cursor}`).catch(() => {});
    }
  }

  return identityMapOf(pairs, limit, maxBytes);
}
