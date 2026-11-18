import type { Db, Tx } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { sql } from 'drizzle-orm';
import { personCrypto } from './crypto';

/** Default window after an erasure in which its identifiers are blocked (#210). */
export const DEFAULT_ERASURE_GRACE_HOURS = 24;

/** A batch filter for the ClickHouse sink: the events that may be stored. */
export type ErasedEventFilter = (events: BusEvent[]) => Promise<BusEvent[]>;

type IdentifierKind = 'anonymous_id' | 'user_id' | 'email' | 'phone';
type PersonIdentifierKind = 'anonymous_id' | 'user_id';

/** One identifier of an event, with the raw value an `identifiers` row would carry and its tombstone hash. */
interface Identifier {
  type: IdentifierKind;
  value: string;
  hash: string;
}

/**
 * Drops events that name an erased person inside their grace window, before the ClickHouse sink
 * stores them (#978 mitigation). The profile resolver applies the same rule to identity (#210),
 * but the sink writes the raw bus events independently: an event still on the bus when the
 * erasure's cleanup swept would otherwise be inserted afterwards, and a late SDK retry would be
 * stored even though no profile is created for it.
 *
 * The resolver only applies a tombstone when none of the event's identifiers belongs to a live
 * profile. Mirroring that is essential: an event that carries an erased visitor's device id
 * together with a genuinely live person's user id is the live person's event, not the erased
 * visitor's, and must be stored. An `alias` follows the resolver's `previousIdents` rule too: its
 * previous id is looked up as an anonymous/user identifier and defaults to anonymous when unknown,
 * and that identifier takes part in the tombstone check.
 *
 * Known-live, previous-id and tombstone lookups are batched into constant-shape queries with array
 * parameters, one per workspace for the whole batch. At the sink's 10,000-event limit a per-pair
 * `IN (…)` list would exceed PostgreSQL's parameter and stack limits.
 *
 * Tombstones are keyed hashes next to the person's rows, so this reads Postgres (the source of
 * truth) on every batch instead of caching: a cache could miss a tombstone committed between the
 * cleanup's delete and the insert. A workspace with no tombstones costs one indexed lookup.
 */
export function erasedEventFilter(opts: { db: Db; kp: KeyProvider; graceHours?: number }): ErasedEventFilter {
  const graceMs = (opts.graceHours ?? DEFAULT_ERASURE_GRACE_HOURS) * 3_600_000;
  return async (events) => {
    if (!events.length) return events;
    const workspaceIds = [...new Set(events.map((e) => e.workspaceId))];
    // The admin pool is the worker's cross-tenant read: it only answers which of this batch's
    // workspaces have ever recorded an erasure, never a person's data.
    const { rows } = await opts.db.admin.query<{ workspace_id: string }>(
      'SELECT DISTINCT workspace_id FROM erasure_tombstones WHERE workspace_id = ANY($1::uuid[])',
      [workspaceIds],
    );
    const affected = new Set(rows.map((r) => r.workspace_id));
    if (!affected.size) return events;

    const dropped = new Set<BusEvent>();
    for (const workspaceId of affected) {
      const batch = events.filter((e) => e.workspaceId === workspaceId);
      if (!batch.length) continue;
      await opts.db.withWorkspace(workspaceId, async (tx) => {
        const crypto = personCrypto(tx, workspaceId, opts.kp);
        // Hash each distinct identifier once; a batch repeats the same visitor many times.
        const byKey = new Map<string, Promise<Identifier>>();
        const identifierOf = (type: IdentifierKind, value: string) => {
          const key = `${type}\u0000${value}`;
          const existing = byKey.get(key);
          if (existing) return existing;
          // E-mail and phone traits are plaintext here; identifiers store their match hash, which
          // is also what the tombstone keeps for that type.
          const identifier =
            type === 'email' || type === 'phone'
              ? crypto.matchHash(type, value).then((hash) => ({ type, value: hash, hash }))
              : crypto.tombstoneHash(type, value).then((hash) => ({ type, value, hash }));
          byKey.set(key, identifier);
          return identifier;
        };
        const perEvent = await Promise.all(
          batch.map(async (e) => {
            const identifiers: Identifier[] = [];
            if (e.anonymousId) identifiers.push(await identifierOf('anonymous_id', e.anonymousId));
            if (e.userId) identifiers.push(await identifierOf('user_id', e.userId));
            for (const type of ['email', 'phone'] as const) {
              const value = e.piiTraits[type];
              if (typeof value === 'string' && value.trim()) identifiers.push(await identifierOf(type, value));
            }
            return identifiers;
          }),
        );

        // The resolver expands an alias's previous id to the anonymous/user identifier types that
        // exist for it, or anonymous when it is unknown (resolve.ts `previousIdents`). One batched
        // query covers every alias in the batch.
        const previousIds = [...new Set(batch.filter((e) => e.type === 'alias' && e.previousId).map((e) => e.previousId!))];
        const previousTypes = new Map<string, PersonIdentifierKind[]>();
        if (previousIds.length) {
          const rows = await tx.execute<{ type: PersonIdentifierKind; value: string }>(sql`
            SELECT type, value FROM identifiers
            WHERE workspace_id = ${workspaceId}
              AND type IN ('anonymous_id', 'user_id')
              AND value = ANY(${sql.param(previousIds)}::text[])`);
          for (const row of rows.rows) previousTypes.set(row.value, [...(previousTypes.get(row.value) ?? []), row.type]);
        }
        for (let index = 0; index < batch.length; index++) {
          const event = batch[index]!;
          if (event.type !== 'alias' || !event.previousId) continue;
          const types = previousTypes.get(event.previousId) ?? ['anonymous_id'];
          for (const type of types) perEvent[index]!.push(await identifierOf(type, event.previousId));
        }

        const resolved = await Promise.all(byKey.values());
        const wanted = [...new Set(resolved.map((i) => i.hash))];
        if (!wanted.length) return;

        // One constant-shape query for every identifier the batch names. An identifier row means
        // the resolver would consider the event known to a live profile, so it is not an erased
        // event. Arrays keep the parameter count fixed at four, whatever the batch size.
        const values: Record<IdentifierKind, Set<string>> = {
          anonymous_id: new Set(),
          user_id: new Set(),
          email: new Set(),
          phone: new Set(),
        };
        for (const identifier of resolved) values[identifier.type].add(identifier.value);
        const knownRows = await tx.execute<{ type: IdentifierKind; value: string }>(sql`
          SELECT type, value FROM identifiers
          WHERE workspace_id = ${workspaceId}
            AND (
              (type = 'anonymous_id' AND value = ANY(${sql.param([...values.anonymous_id])}::text[]))
              OR (type = 'user_id' AND value = ANY(${sql.param([...values.user_id])}::text[]))
              OR (type = 'email' AND value = ANY(${sql.param([...values.email])}::text[]))
              OR (type = 'phone' AND value = ANY(${sql.param([...values.phone])}::text[]))
            )`);
        const known = new Set(knownRows.rows.map((r) => `${r.type}\u0000${r.value}`));

        const tombstones = await tx.execute<{ ident_hash: string; erased_at: Date | string }>(sql`
          SELECT ident_hash, erased_at FROM erasure_tombstones
          WHERE workspace_id = ${workspaceId} AND ident_hash = ANY(${sql.param(wanted)}::text[])`);
        const erasedAt = new Map(tombstones.rows.map((row) => [row.ident_hash, new Date(row.erased_at).getTime()]));
        batch.forEach((event, index) => {
          const ids = perEvent[index]!;
          if (ids.some((id) => known.has(`${id.type}\u0000${id.value}`))) return;
          const times = ids.map((id) => erasedAt.get(id.hash)).filter((at): at is number => at !== undefined);
          if (!times.length) return;
          // The same rule as the resolver: an event that happened before the erasure plus the
          // grace window belongs to the erased person. After the window the id may be a new person.
          if (Date.parse(event.timestamp) < Math.max(...times) + graceMs) dropped.add(event);
        });
      });
    }
    if (dropped.size) logger.info({ events: dropped.size }, 'dropped events naming an erased person before the event store');
    return events.filter((event) => !dropped.has(event));
  };
}

/**
 * Profile ids that have an erasure record. A missing profile row alone is not proof of erasure:
 * synthetic, imported or profile-less rows are legitimate. Only `erasures.profile_ids` records an
 * erasure, and it includes the whole merged family.
 */
export async function erasedProfileIdsInTx(tx: Tx, workspaceId: string, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (!unique.length) return new Set();
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT unnest(profile_ids) AS id FROM erasures
    WHERE workspace_id = ${workspaceId} AND profile_ids && ${sql.param(unique)}::text[]`);
  return new Set(rows.rows.map((row) => row.id));
}

/**
 * Drops rows for a profile that has an erasure record, just before a direct ClickHouse write
 * (#978 mitigation). The journey sweeper, enrollment and command holdouts write journey events
 * outside the outbox and the sink; this keeps most post-erasure writes out at those call sites.
 * Rows without a profile id are kept, and a profile row that merely does not exist is not treated
 * as erased. A write that passed this check before the erasure is still covered by the cleanup's
 * second sweep only if it lands before that sweep; later writes need #1037.
 */
export async function dropErasedProfileRows<T extends { profileId?: string | null }>(db: Db, workspaceId: string, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.map((row) => row.profileId).filter((id): id is string => !!id))];
  if (!ids.length) return rows;
  const erased = await db.withWorkspace(workspaceId, (tx) => erasedProfileIdsInTx(tx, workspaceId, ids));
  if (!erased.size) return rows;
  return rows.filter((row) => !row.profileId || !erased.has(row.profileId));
}
