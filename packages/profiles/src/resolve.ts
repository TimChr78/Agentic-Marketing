import type { Purposes } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { type IdentifierType, schema, type Tx } from '@agentic-marketing/db';
import { type BusEvent, CONSENT_EVENT } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { consentStateOf, currentConsent, recomputeConsentState, recordConsent } from './consent';
import { type PersonCrypto, personCrypto } from './crypto';

// Deterministic identity resolution (data-platform.md §3). Each event's identifiers are looked up;
// unknown ones are attached, and when they point at several profiles those are merged, as long as
// that never joins two different user ids, e-mail addresses or phone numbers. The oldest profile
// survives. Events in ClickHouse are never rewritten: a profile's events are found through its
// identifiers.

/** Identifier types a profile can have at most one value of. */
const UNIQUE: IdentifierType[] = ['user_id', 'email', 'phone'];
/** Don't rewrite last_seen more often than this. */
const SEEN_GRANULARITY_MS = 5 * 60_000;

interface Ident {
  type: IdentifierType;
  value: string;
  /** Plaintext to store sealed (e-mail, phone). */
  plain?: string;
}

async function identsOf(e: BusEvent, crypto: PersonCrypto): Promise<Ident[]> {
  const out: Ident[] = [];
  if (e.anonymousId) out.push({ type: 'anonymous_id', value: e.anonymousId });
  if (e.userId) out.push({ type: 'user_id', value: e.userId });
  for (const type of ['email', 'phone'] as const) {
    const v = e.piiTraits[type];
    if (typeof v === 'string' && v.trim()) out.push({ type, value: await crypto.matchHash(type, v), plain: v.trim() });
  }
  return out;
}

const hasProfileData = (e: BusEvent) =>
  Object.keys(e.traits).length > 0 || Object.keys(e.piiTraits).length > 0 || e.name === CONSENT_EVENT || e.type === 'alias';

/** Events the platform publishes about existing people (packages/segments uses the same id). */
const SYSTEM_SOURCE = 'system';

export interface ResolveDeps {
  kp: KeyProvider;
  purposes: (tx: Tx) => Promise<Purposes>;
}

export interface ResolvedEvent {
  event: BusEvent;
  profileId: string;
}

/**
 * Applies one workspace's events, in order, in the given transaction, and returns which profile
 * each event belongs to. Safe to re-run (at-least-once delivery).
 */
export async function applyEvents(tx: Tx, workspaceId: string, events: BusEvent[], deps: ResolveDeps): Promise<ResolvedEvent[]> {
  const crypto = personCrypto(tx, workspaceId, deps.kp);
  const resolved: ResolvedEvent[] = [];
  let purposes: Purposes | undefined;
  for (const e of events) {
    const ids = await identsOf(e, crypto);
    if (e.type === 'alias' && e.previousId) ids.push(...(await previousIdents(tx, workspaceId, e.previousId)));
    if (!ids.length) continue;

    // Fast path, most events: known identifiers of one profile, nothing to change but last seen.
    const known = await lookup(tx, workspaceId, ids);
    const profilesKnown = new Set(known.map((k) => k.profileId));
    // The platform's own events (segment entered/exited) describe someone who exists. One still in
    // flight when that person was erased must not create a new profile from their ids.
    if (e.sourceId === SYSTEM_SOURCE && !known.length) continue;
    if (!hasProfileData(e) && known.length === ids.length && profilesKnown.size === 1) {
      await touch(tx, workspaceId, [...profilesKnown][0], ids, e.timestamp);
      resolved.push({ event: e, profileId: [...profilesKnown][0] });
      continue;
    }

    // Anything that creates, attaches or merges is serialised per workspace, so concurrent shard
    // consumers cannot interleave on the same people.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}`}, 0))`);
    const profileId = await resolve(tx, workspaceId, ids, crypto, e);
    await updateProfile(tx, workspaceId, profileId, e, crypto);
    if (e.name === CONSENT_EVENT && Object.keys(e.consent).length) {
      purposes ??= await deps.purposes(tx);
      await recordSdkConsent(tx, workspaceId, profileId, e, purposes);
    }
    resolved.push({ event: e, profileId });
  }
  return resolved;
}

async function previousIdents(tx: Tx, workspaceId: string, previousId: string): Promise<Ident[]> {
  const rows = await tx
    .select({ type: schema.identifiers.type })
    .from(schema.identifiers)
    .where(
      and(
        eq(schema.identifiers.workspaceId, workspaceId),
        inArray(schema.identifiers.type, ['anonymous_id', 'user_id']),
        eq(schema.identifiers.value, previousId),
      ),
    );
  return rows.length ? rows.map((r) => ({ type: r.type, value: previousId })) : [{ type: 'anonymous_id', value: previousId }];
}

async function lookup(tx: Tx, workspaceId: string, ids: Ident[]) {
  const res = await tx.execute<{ type: IdentifierType; value: string; profile_id: string }>(sql`
    SELECT type, value, profile_id FROM identifiers
    WHERE workspace_id = ${workspaceId} AND (type, value) IN (${sql.join(
      ids.map((i) => sql`(${i.type}, ${i.value})`),
      sql`, `,
    )})`);
  return res.rows.map((r) => ({ type: r.type, value: r.value, profileId: r.profile_id }));
}

async function touch(tx: Tx, workspaceId: string, profileId: string, ids: Ident[], at: string) {
  const seen = new Date(at);
  const stale = new Date(seen.getTime() - SEEN_GRANULARITY_MS);
  await tx.execute(sql`
    UPDATE profiles SET last_seen = ${seen} WHERE workspace_id = ${workspaceId} AND id = ${profileId} AND last_seen < ${stale}`);
  await tx.execute(sql`
    UPDATE identifiers SET last_seen = ${seen}
    WHERE workspace_id = ${workspaceId} AND profile_id = ${profileId} AND last_seen < ${stale}
      AND (type, value) IN (${sql.join(
        ids.map((i) => sql`(${i.type}, ${i.value})`),
        sql`, `,
      )})`);
}

async function uniqueValues(tx: Tx, workspaceId: string, profileIds: string[]) {
  const rows = await tx
    .select({ type: schema.identifiers.type, value: schema.identifiers.value, profileId: schema.identifiers.profileId })
    .from(schema.identifiers)
    .where(
      and(
        eq(schema.identifiers.workspaceId, workspaceId),
        inArray(schema.identifiers.profileId, profileIds),
        inArray(schema.identifiers.type, UNIQUE),
      ),
    );
  return rows;
}

async function resolve(tx: Tx, workspaceId: string, ids: Ident[], crypto: PersonCrypto, e: BusEvent): Promise<string> {
  const known = await lookup(tx, workspaceId, ids);
  const candidates = [...new Set(known.map((k) => k.profileId))];
  let target: string;

  if (!candidates.length) {
    target = newId('prf');
    await tx.insert(schema.profiles).values({ workspaceId, id: target, firstSeen: new Date(e.timestamp), lastSeen: new Date(e.timestamp) });
  } else if (candidates.length === 1) {
    target = candidates[0];
  } else {
    // Merge only if the profiles together still have at most one user id, e-mail and phone.
    const uniques = await uniqueValues(tx, workspaceId, candidates);
    const conflict = UNIQUE.some((t) => new Set(uniques.filter((u) => u.type === t).map((u) => u.value)).size > 1);
    const rows = await tx
      .select({ id: schema.profiles.id, createdAt: schema.profiles.createdAt })
      .from(schema.profiles)
      .where(and(eq(schema.profiles.workspaceId, workspaceId), inArray(schema.profiles.id, candidates)))
      .orderBy(schema.profiles.createdAt, schema.profiles.id);
    if (conflict) {
      // Attach to the profile the strongest identifier points at; leave the others alone.
      const strongest = known.find((k) => k.type === 'user_id') ?? known.find((k) => k.type === 'email') ?? known[0];
      target = strongest.profileId;
      logger.warn({ workspaceId, profiles: candidates }, 'identity conflict: identifiers of different people in one event; not merged');
    } else {
      target = rows[0].id;
      for (const loser of rows.slice(1)) await merge(tx, workspaceId, loser.id, target, crypto, `${e.type} ${e.messageId}`);
    }
  }

  // Attach identifiers that are new, unless that would give the profile a second unique value.
  const after = await lookup(tx, workspaceId, ids);
  const owned = await uniqueValues(tx, workspaceId, [target]);
  for (const i of ids) {
    if (after.some((k) => k.type === i.type && k.value === i.value)) continue;
    if (UNIQUE.includes(i.type) && owned.some((o) => o.type === i.type && o.value !== i.value)) {
      logger.warn({ workspaceId, profileId: target, type: i.type }, 'identity conflict: profile already has another value; not attached');
      continue;
    }
    await tx.insert(schema.identifiers).values({
      workspaceId,
      type: i.type,
      value: i.value,
      profileId: target,
      valueEnc: i.plain ? await crypto.seal(target, i.plain) : null,
      firstSeen: new Date(e.timestamp),
      lastSeen: new Date(e.timestamp),
    });
    owned.push({ type: i.type, value: i.value, profileId: target });
  }
  return target;
}

/** Folds `from` into `into`: identifiers, traits and personal data move; consent state is recomputed. */
async function merge(tx: Tx, workspaceId: string, from: string, into: string, crypto: PersonCrypto, reason: string) {
  const [src] = await tx
    .select()
    .from(schema.profiles)
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, from)));
  const [dst] = await tx
    .select()
    .from(schema.profiles)
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, into)));

  // Sealed identifier values are re-sealed with the survivor's key.
  const moved = await tx
    .select()
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.workspaceId, workspaceId), eq(schema.identifiers.profileId, from)));
  for (const i of moved) {
    const plain = i.valueEnc ? await crypto.open<string>(from, i.valueEnc) : undefined;
    await tx
      .update(schema.identifiers)
      .set({ profileId: into, valueEnc: plain === undefined ? null : await crypto.seal(into, plain) })
      .where(
        and(eq(schema.identifiers.workspaceId, workspaceId), eq(schema.identifiers.type, i.type), eq(schema.identifiers.value, i.value)),
      );
  }

  // Journeys follow the person: a participant waiting for an event of the merged-away profile is
  // now found by the survivor's events (including the one that caused this merge).
  await tx.execute(
    sql`UPDATE journey_participants SET profile_id = ${into}, updated_at = now() WHERE workspace_id = ${workspaceId} AND profile_id = ${from}`,
  );
  // Holdout arms follow too: the survivor keeps its arm for a scope and otherwise inherits the
  // merged profile's (earliest wins). The function is the app role's only way to move these rows.
  await tx.execute(sql`SELECT merge_holdout_assignments(${from}, ${into})`);

  const srcPii = (await crypto.open<Record<string, unknown>>(from, src.pii)) ?? {};
  const dstPii = (await crypto.open<Record<string, unknown>>(into, dst.pii)) ?? {};
  const pii = { ...srcPii, ...dstPii };
  await tx
    .update(schema.profiles)
    .set({
      traits: { ...src.traits, ...dst.traits },
      pii: Object.keys(pii).length ? await crypto.seal(into, pii) : dst.pii,
      firstSeen: src.firstSeen < dst.firstSeen ? src.firstSeen : dst.firstSeen,
      lastSeen: src.lastSeen > dst.lastSeen ? src.lastSeen : dst.lastSeen,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, into)));
  await tx
    .update(schema.profiles)
    .set({ mergedInto: into, traits: {}, pii: null, updatedAt: new Date() })
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, from)));
  // The merged profile holds no personal data any more; its key goes.
  await tx.delete(schema.profileKeys).where(and(eq(schema.profileKeys.workspaceId, workspaceId), eq(schema.profileKeys.profileId, from)));
  await tx.insert(schema.profileMerges).values({ workspaceId, fromId: from, intoId: into, reason }).onConflictDoNothing();
  await tx
    .delete(schema.consentState)
    .where(and(eq(schema.consentState.workspaceId, workspaceId), eq(schema.consentState.profileId, from)));
  await recomputeConsentState(tx, workspaceId, into);
}

async function updateProfile(tx: Tx, workspaceId: string, profileId: string, e: BusEvent, crypto: PersonCrypto) {
  const [p] = await tx
    .select()
    .from(schema.profiles)
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, profileId)));
  const seen = new Date(e.timestamp);
  const changes: Partial<typeof schema.profiles.$inferInsert> = {};
  if (Object.keys(e.traits).length) changes.traits = { ...p.traits, ...e.traits };
  const pii = Object.fromEntries(Object.entries(e.piiTraits).filter(([k]) => k !== 'email' && k !== 'phone'));
  // E-mail and phone are kept (sealed) on the identifiers; other personal traits in the profile.
  if (Object.keys(pii).length) {
    const current = (await crypto.open<Record<string, unknown>>(profileId, p.pii)) ?? {};
    changes.pii = await crypto.seal(profileId, { ...current, ...pii });
  }
  if (seen > p.lastSeen) changes.lastSeen = seen;
  if (seen < p.firstSeen) changes.firstSeen = seen;
  if (!Object.keys(changes).length) return;
  await tx
    .update(schema.profiles)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, profileId)));
}

async function recordSdkConsent(tx: Tx, workspaceId: string, profileId: string, e: BusEvent, purposes: Purposes) {
  const state = await consentStateOf(tx, workspaceId, profileId);
  const current = new Map([...new Set(state.map((s) => s.purpose))].map((p) => [p, currentConsent(state, p)?.status]));
  const records = Object.entries(e.consent).map(([purpose, allowed]) => ({
    purpose,
    status: allowed ? ('granted' as const) : current.get(purpose) === 'granted' ? ('withdrawn' as const) : ('denied' as const),
    source: 'sdk' as const,
    messageId: e.messageId,
    recordedAt: new Date(e.timestamp),
    proof: {
      messageId: e.messageId,
      sourceId: e.sourceId,
      ip: e.context.ip,
      userAgent: e.context.userAgent,
      page: (e.context.page as { url?: string } | undefined)?.url,
    },
  }));
  // Only changes are worth a record; a page load repeating the same choice is not one.
  const changed = records.filter(
    (r) => current.get(r.purpose) !== r.status && !(r.status === 'denied' && current.get(r.purpose) === 'withdrawn'),
  );
  await recordConsent(tx, workspaceId, profileId, purposes, changed);
}
