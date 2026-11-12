import { IDENTITY_FIELD_BYTES, type IdentityPair } from '@agentic-marketing/campaigns';

// Every query that ships the campaign-scoped identity map uses this builder (#590). The map is
// one logical list of (key, profile, kind) triples, but ClickHouse rejects an HTTP form field
// larger than `http_max_field_value_size` (128 KiB on the supported version). The three arrays are
// therefore split into index-aligned chunks and joined back with `arrayConcat` inside the query.
//
// Keeping the chunking here, rather than in each query, is what stops a second surface from
// silently sending one unchunked array and failing only for a large campaign (#588, #590).

export interface IdentityChunk {
  keys: string[];
  profiles: string[];
  kinds: string[];
}

/**
 * Splits the three identity arrays into chunks whose serialised fields stay under ClickHouse's
 * per-field limit. Chunking keeps the arrays index-aligned; `arrayConcat` restores them.
 */
export function identityChunks(pairs: readonly IdentityPair[]): IdentityChunk[] {
  const chunks: IdentityChunk[] = [];
  let chunk: IdentityChunk = { keys: [], profiles: [], kinds: [] };
  let keyBytes = 2;
  let profileBytes = 2;
  let kindBytes = 2;
  const flush = () => {
    if (!chunk.keys.length) return;
    chunks.push(chunk);
    chunk = { keys: [], profiles: [], kinds: [] };
    keyBytes = 2;
    profileBytes = 2;
    kindBytes = 2;
  };
  for (const pair of pairs) {
    const key = Buffer.byteLength(JSON.stringify(pair.key)) + 1;
    const profile = Buffer.byteLength(JSON.stringify(pair.profileId)) + 1;
    const kind = Buffer.byteLength(JSON.stringify(pair.kind)) + 1;
    if (
      chunk.keys.length &&
      (keyBytes + key > IDENTITY_FIELD_BYTES || profileBytes + profile > IDENTITY_FIELD_BYTES || kindBytes + kind > IDENTITY_FIELD_BYTES)
    )
      flush();
    chunk.keys.push(pair.key);
    chunk.profiles.push(pair.profileId);
    chunk.kinds.push(pair.kind);
    keyBytes += key;
    profileBytes += profile;
    kindBytes += kind;
  }
  flush();
  if (!chunks.length) chunks.push({ keys: [], profiles: [], kinds: [] });
  return chunks;
}

export interface IdentityQueryParams {
  /** SQL expression for the identity keys array, chunked when needed. */
  keys: string;
  /** SQL expression for the identity profile array, chunked when needed. */
  profiles: string;
  /** SQL expression for the identity kind array, chunked when needed. */
  kinds: string;
  count: number;
  /** The `{identity_*_N:Array(String)}` parameters the expressions refer to. */
  params: Record<string, unknown>;
}

/** One builder for every query that ships the identity map to ClickHouse. */
export function identityQueryParams(pairs: readonly IdentityPair[]): IdentityQueryParams {
  const chunks = identityChunks(pairs);
  const array = (field: 'keys' | 'profiles' | 'kinds') =>
    chunks.length === 1
      ? `{identity_${field}_0:Array(String)}`
      : `arrayConcat(${chunks.map((_, i) => `{identity_${field}_${i}:Array(String)}`).join(', ')})`;
  const params: Record<string, unknown> = {};
  chunks.forEach((chunk, i) => {
    params[`identity_keys_${i}`] = chunk.keys;
    params[`identity_profiles_${i}`] = chunk.profiles;
    params[`identity_kinds_${i}`] = chunk.kinds;
  });
  return { keys: array('keys'), profiles: array('profiles'), kinds: array('kinds'), count: pairs.length, params };
}
