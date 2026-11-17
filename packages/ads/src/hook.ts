import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { type Db, schema } from '@agentic-marketing/db';
import { consentOf } from '@agentic-marketing/events';
import { canonicalProfile, consentStateOf, currentConsent, type ResolvedEvent, withIdentityLock } from '@agentic-marketing/profiles';
import { sql } from 'drizzle-orm';
import { CLICK_ID_TYPES, clickIdsOfEvent, purposeHolds } from './clickIds';

/**
 * Post-resolve hook: stores the click ids an event carries as identifiers of its profile, when
 * `ad_measurement` holds (a ledger refusal wins over the event's consent signal, else the signal
 * or a ledger grant). A click id seen again keeps its first profile and first-seen time.
 *
 * This is an identity writer, so it takes the workspace identity lock before its first read and
 * follows the event's resolved profile to today's canonical one under the lock: the worker
 * resolved the event before this hook ran, and a merge in between moved the person. An erased
 * person is skipped (no identifier may recreate a row for them).
 */
export function clickIdHook(deps: { db: Db }) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    const withIds = resolved
      .map((r) => ({ r, ids: clickIdsOfEvent(r.event.context, Date.parse(r.event.timestamp) || Date.now()) }))
      .filter((x) => Object.keys(x.ids).length);
    if (!withIds.length) return;
    await deps.db.withWorkspace(workspaceId, (tx) =>
      withIdentityLock(tx, workspaceId, async () => {
        const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
        const ledger = new Map<string, string | undefined>();
        for (const { r, ids } of withIds) {
          const person = await canonicalProfile(tx, workspaceId, r.profileId);
          if (!person) continue;
          if (!ledger.has(person.id))
            ledger.set(person.id, currentConsent(await consentStateOf(tx, workspaceId, person.id), 'ad_measurement')?.status);
          if (!purposeHolds(purposes, 'ad_measurement', consentOf(r.event.context)?.ad_measurement, ledger.get(person.id))) continue;
          for (const type of CLICK_ID_TYPES) {
            const value = ids[type];
            if (!value) continue;
            await tx
              .insert(schema.identifiers)
              .values({
                workspaceId,
                type,
                value,
                profileId: person.id,
                firstSeen: new Date(r.event.timestamp),
                lastSeen: new Date(r.event.timestamp),
              })
              .onConflictDoUpdate({
                target: [schema.identifiers.workspaceId, schema.identifiers.type, schema.identifiers.value],
                set: { lastSeen: sql`greatest(${schema.identifiers.lastSeen}, excluded.last_seen)` },
              });
          }
        }
      }),
    );
  };
}
