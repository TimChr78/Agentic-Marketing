import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

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
 * The most one recipient can add to the map: a merged-away profile, plus the two identifier kinds
 * an event can resolve by (user id and anonymous id). At three pairs per recipient the bound is the
 * largest campaign the platform supports, not an arbitrary transport number.
 */
export const IDENTITY_PAIRS_PER_RECIPIENT = 3;

/**
 * At most this many pairs travel to ClickHouse as parameter arrays. A campaign-scoped map cannot
 * exceed it through unrelated workspace growth, and the largest supported campaign fits it.
 */
export const IDENTITY_MAP_LIMIT = MAX_CAMPAIGN_RECIPIENTS * IDENTITY_PAIRS_PER_RECIPIENT;

/**
 * The byte bound that goes with the pair bound: at 36-character ids the worst case is
 * 300,000 * (36 + 36 + 8) = 24,000,000 bytes. Params above the URL budget travel in the multipart
 * body (`use_multipart_params_auto`), which is bounded by request size rather than by count.
 */
export const IDENTITY_MAP_MAX_BYTES = 32 * 1024 * 1024;

/**
 * ClickHouse rejects an HTTP form field longer than `http_max_field_value_size` (128 KiB on the
 * supported version), so a shipped array is split across several fields below that limit. This is
 * the per-field budget, not the bound on the map: the map's total size is bounded above.
 */
export const IDENTITY_FIELD_BYTES = 120 * 1024;

export const emptyIdentityMap = (): IdentityMap => ({ pairs: [], overLimit: false, limit: IDENTITY_MAP_LIMIT });

/** Follows a merge chain to its survivor. A cycle, which a merge must never create, stops safely. */
export function survivorOf(id: string, mergedInto: ReadonlyMap<string, string>): string {
  let current = id;
  const seen = new Set<string>();
  while (mergedInto.has(current)) {
    if (seen.has(current)) break;
    seen.add(current);
    current = mergedInto.get(current)!;
  }
  return current;
}

/**
 * The connected merge component around `ids`: every profile merged into or out of the same chain.
 * A recipient stored as A needs its survivor B, and a recipient stored as B needs the historical
 * A, because an event may still carry either id. Exported for its test.
 */
export function mergeComponent(ids: Iterable<string>, mergedInto: ReadonlyMap<string, string>): Set<string> {
  const adjacent = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const neighbours = adjacent.get(from) ?? new Set<string>();
    neighbours.add(to);
    adjacent.set(from, neighbours);
  };
  for (const [source, survivor] of mergedInto) {
    link(source, survivor);
    link(survivor, source);
  }
  const component = new Set(ids);
  const queue = [...component];
  while (queue.length) {
    const id = queue.pop()!;
    for (const neighbour of adjacent.get(id) ?? []) {
      if (component.has(neighbour)) continue;
      component.add(neighbour);
      queue.push(neighbour);
    }
  }
  return component;
}

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
 */
export async function loadIdentityMap(tx: Tx, workspaceId: string, opts: { profileIds?: readonly string[] } = {}): Promise<IdentityMap> {
  const scope = opts.profileIds ? [...new Set(opts.profileIds)] : undefined;
  if (scope && !scope.length) return emptyIdentityMap();

  const merged = await tx
    .select({ id: schema.profiles.id, mergedInto: schema.profiles.mergedInto })
    .from(schema.profiles)
    .where(and(eq(schema.profiles.workspaceId, workspaceId), isNotNull(schema.profiles.mergedInto)));
  const mergedInto = new Map(merged.flatMap((m) => (m.mergedInto ? [[m.id, m.mergedInto] as const] : [])));

  // Scoped callers measure a bounded set of people: keep the whole merge chain around them, in
  // both directions, so a recipient stored under either the historical or the surviving id resolves.
  const inScope = scope ? mergeComponent(scope, mergedInto) : undefined;
  const pairs: IdentityPair[] = [];
  const affected = new Set<string>();
  for (const source of mergedInto.keys()) {
    const survivor = survivorOf(source, mergedInto);
    if (inScope && !(inScope.has(source) || inScope.has(survivor))) continue;
    pairs.push({ key: source, profileId: survivor, kind: 'profile' });
    affected.add(source);
    affected.add(survivor);
  }

  // Merging re-points identifiers to the survivor, so the current owner is the place to look.
  const owners = inScope ? [...inScope] : [...affected];
  const identifiers: {
    type: string;
    value: string;
    profileId: string;
  }[] = [];
  for (let i = 0; i < owners.length; i += PROFILE_ID_CHUNK) {
    identifiers.push(
      ...(await tx
        .select({ type: schema.identifiers.type, value: schema.identifiers.value, profileId: schema.identifiers.profileId })
        .from(schema.identifiers)
        .where(
          and(
            eq(schema.identifiers.workspaceId, workspaceId),
            inArray(schema.identifiers.type, ['anonymous_id', 'user_id']),
            inArray(schema.identifiers.profileId, owners.slice(i, i + PROFILE_ID_CHUNK)),
          ),
        )),
    );
  }
  for (const identifier of identifiers)
    pairs.push({
      key: identifier.value,
      profileId: survivorOf(identifier.profileId, mergedInto),
      // The query only selects the two identifier kinds the event store can resolve an event by.
      kind: identifier.type as IdentityKind,
    });

  return identityMapOf(pairs);
}
