import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { type Db, schema } from '@agentic-marketing/db';
import { consentOf } from '@agentic-marketing/events';
import { consentStateOf, type ResolvedEvent } from '@agentic-marketing/profiles';
import { sql } from 'drizzle-orm';
import { CLICK_ID_TYPES, clickIdsOfEvent, purposeHolds } from './clickIds';

/**
 * Post-resolve hook: stores the click ids an event carries as identifiers of its profile, when
 * `ad_measurement` holds (the event's consent signal, else the consent ledger). A click id seen
 * again keeps its first profile and first-seen time.
 */
export function clickIdHook(deps: { db: Db }) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    const withIds = resolved
      .map((r) => ({ r, ids: clickIdsOfEvent(r.event.context, Date.parse(r.event.timestamp) || Date.now()) }))
      .filter((x) => Object.keys(x.ids).length);
    if (!withIds.length) return;
    await deps.db.withWorkspace(workspaceId, async (tx) => {
      const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
      const ledger = new Map<string, string | undefined>();
      for (const { r, ids } of withIds) {
        if (!ledger.has(r.profileId))
          ledger.set(
            r.profileId,
            (await consentStateOf(tx, workspaceId, r.profileId))
              .filter((s) => s.purpose === 'ad_measurement')
              .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]?.status,
          );
        if (!purposeHolds(purposes, 'ad_measurement', consentOf(r.event.context)?.ad_measurement, ledger.get(r.profileId))) continue;
        for (const type of CLICK_ID_TYPES) {
          const value = ids[type];
          if (!value) continue;
          await tx
            .insert(schema.identifiers)
            .values({
              workspaceId,
              type,
              value,
              profileId: r.profileId,
              firstSeen: new Date(r.event.timestamp),
              lastSeen: new Date(r.event.timestamp),
            })
            .onConflictDoUpdate({
              target: [schema.identifiers.workspaceId, schema.identifiers.type, schema.identifiers.value],
              set: { lastSeen: sql`greatest(${schema.identifiers.lastSeen}, excluded.last_seen)` },
            });
        }
      }
    });
  };
}
