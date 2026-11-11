import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

// One identity resolution for campaign conversions (#590).
//
// ClickHouse keeps the profile id an event had when it was stored. A merge does not rewrite it,
// but identifiers do follow the merge survivor, so the holdout card resolved events through
// identifiers while the campaign headline joined the stored profile id: one screen, two numbers.
// Both surfaces now resolve an event through the same map, so a merge cannot make one count and
// the other not.
//
// The map holds every key whose resolution differs from the event's stored profile id: a profile
// that was merged away, and the anonymous ids / user ids that moved to its survivor. A profile
// that was never merged cannot differ, because ingest stores the profile id it resolved; the
// measure query therefore does not ship every identifier of the workspace. A scoped caller (the
// holdout) may ask for every identifier of the people it measures instead.

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
   * True when the map is larger than the transport bound. The measure query must then ship no map
   * at all (never a partial one) and report that the result is not identity-resolved.
   */
  overLimit: boolean;
  limit: number;
}

/**
 * At most this many pairs and this much key text travel to ClickHouse as parameter arrays, which
 * keeps each field inside the 128 KiB multipart limit the client uses. Larger workspaces still
 * have a complete map in-process (the holdout keeps counting); only the measure query omits it,
 * and its `meta.notes` says so.
 */
export const IDENTITY_MAP_LIMIT = 2000;
const IDENTITY_MAP_MAX_BYTES = 96 * 1024;

const emptyMap = (): IdentityMap => ({ pairs: [], overLimit: false, limit: IDENTITY_MAP_LIMIT });

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

/** Deduplicates the pairs by kind and key and applies the transport bound. Exported for its test. */
export function identityMapOf(pairs: readonly IdentityPair[], limit = IDENTITY_MAP_LIMIT): IdentityMap {
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
  return { pairs: all, overLimit: all.length > limit || bytes > IDENTITY_MAP_MAX_BYTES, limit };
}

/**
 * Every key whose identity differs from the stored event profile id, or every identifier of the
 * given people when `profileIds` is set. The workspace always comes from the caller's transaction.
 */
export async function loadIdentityMap(tx: Tx, workspaceId: string, opts: { profileIds?: readonly string[] } = {}): Promise<IdentityMap> {
  const scope = opts.profileIds ? [...new Set(opts.profileIds)] : undefined;
  if (scope && !scope.length) return emptyMap();

  const merged = await tx
    .select({ id: schema.profiles.id, mergedInto: schema.profiles.mergedInto })
    .from(schema.profiles)
    .where(and(eq(schema.profiles.workspaceId, workspaceId), isNotNull(schema.profiles.mergedInto)));
  const mergedInto = new Map(merged.flatMap((m) => (m.mergedInto ? [[m.id, m.mergedInto] as const] : [])));

  const inScope = scope ? new Set(scope) : undefined;
  const pairs: IdentityPair[] = [];
  const affected = new Set<string>();
  for (const source of mergedInto.keys()) {
    const survivor = survivorOf(source, mergedInto);
    if (inScope && !inScope.has(survivor)) continue;
    pairs.push({ key: source, profileId: survivor, kind: 'profile' });
    affected.add(source);
    affected.add(survivor);
  }

  // Merging re-points identifiers to the survivor, so the current owner is the place to look.
  const owners = inScope ? [...inScope] : [...affected];
  const identifiers = owners.length
    ? await tx
        .select({ type: schema.identifiers.type, value: schema.identifiers.value, profileId: schema.identifiers.profileId })
        .from(schema.identifiers)
        .where(
          and(
            eq(schema.identifiers.workspaceId, workspaceId),
            inArray(schema.identifiers.type, ['anonymous_id', 'user_id']),
            inArray(schema.identifiers.profileId, owners),
          ),
        )
    : [];
  for (const identifier of identifiers)
    pairs.push({
      key: identifier.value,
      profileId: survivorOf(identifier.profileId, mergedInto),
      // The query only selects the two identifier kinds the event store can resolve an event by.
      kind: identifier.type as IdentityKind,
    });

  return identityMapOf(pairs);
}
