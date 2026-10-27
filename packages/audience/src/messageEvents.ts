import type { Db } from '@agentic-marketing/db';
import type { EventBus, EventStore, MessageEvent } from '@agentic-marketing/events';
import { acceptItems, sourceLookups } from '@agentic-marketing/ingest';
import { logger } from '@agentic-marketing/telemetry';

// What happens to e-mails becomes part of the person's story: sent, delivered, bounced,
// complained, clicked and unsubscribed are published as customer events ("Email Link Clicked"…)
// next to the message log in ClickHouse, so segments ("clicked the newsletter in 30 days"),
// journey branches and webhook subscriptions can use them. The source is "email".

export const EMAIL_EVENTS: Partial<Record<MessageEvent['type'], string>> = {
  sent: 'Email Sent',
  delivered: 'Email Delivered',
  bounced: 'Email Bounced',
  complained: 'Email Complained',
  clicked: 'Email Link Clicked',
  unsubscribed: 'Email Unsubscribed',
};

/**
 * Adds the profile id to raw events before they reach ClickHouse. One lookup per workspace and
 * batch resolves both identifiers; an unknown person keeps the empty string, so campaign
 * attribution never guesses. This is what lets a conversion event join the message log.
 */
export function withResolvedEventProfiles(store: EventStore, db: Db): EventStore {
  return {
    ...store,
    async insert(events) {
      if (!events.length) return store.insert(events);
      const unresolved = new Set(events.flatMap((e, i) => (e.profileId ? [] : [i])));
      if (!unresolved.size) return store.insert(events);

      const byWorkspace = new Map<string, { userIds: Set<string>; anonymousIds: Set<string> }>();
      for (const i of unresolved) {
        const e = events[i]!;
        const entry = byWorkspace.get(e.workspaceId) ?? { userIds: new Set<string>(), anonymousIds: new Set<string>() };
        if (e.userId) entry.userIds.add(e.userId);
        if (e.anonymousId) entry.anonymousIds.add(e.anonymousId);
        byWorkspace.set(e.workspaceId, entry);
      }

      const ids = new Map<string, string>();
      for (const [workspaceId, entry] of byWorkspace) {
        const { rows } = await db.admin.query<{ type: string; value: string; profile_id: string }>(
          `SELECT type, value, profile_id FROM identifiers
           WHERE workspace_id = $1
             AND ((type = 'user_id' AND value = ANY($2)) OR (type = 'anonymous_id' AND value = ANY($3)))`,
          [workspaceId, [...entry.userIds], [...entry.anonymousIds]],
        );
        for (const row of rows) ids.set(`${workspaceId}:${row.type}:${row.value}`, row.profile_id);
      }

      const resolved = events.map((e, i) => {
        if (!unresolved.has(i)) return e;
        const profileId =
          (e.userId ? ids.get(`${e.workspaceId}:user_id:${e.userId}`) : undefined) ??
          (e.anonymousId ? ids.get(`${e.workspaceId}:anonymous_id:${e.anonymousId}`) : undefined);
        return profileId ? { ...e, profileId } : e;
      });
      return store.insert(resolved);
    },
  };
}

/** Wraps an event store so message events are also published to the bus as customer events. */
export function withEmailProfileEvents(store: EventStore, deps: { db: Db; bus: EventBus }): EventStore {
  const { loadPolicy } = sourceLookups(deps.db);
  async function publish(events: MessageEvent[]) {
    const byWs = new Map<string, MessageEvent[]>();
    for (const e of events) if (EMAIL_EVENTS[e.type] && e.profileId) byWs.set(e.workspaceId, [...(byWs.get(e.workspaceId) ?? []), e]);
    for (const [ws, list] of byWs) {
      // The person's own id on the bus: their user id, else an anonymous id they are known by.
      const { rows } = await deps.db.admin.query<{ profile_id: string; type: string; value: string }>(
        `SELECT DISTINCT ON (profile_id) profile_id, type, value FROM identifiers
         WHERE workspace_id = $1 AND profile_id = ANY($2) AND type IN ('user_id', 'anonymous_id')
         ORDER BY profile_id, (type = 'user_id') DESC, last_seen DESC`,
        [ws, [...new Set(list.map((e) => e.profileId))]],
      );
      const who = new Map(rows.map((r) => [r.profile_id, r.type === 'user_id' ? { userId: r.value } : { anonymousId: r.value }]));
      const items = list.flatMap((e) => {
        const id = who.get(e.profileId);
        if (!id) return [];
        return [
          {
            type: 'track',
            event: EMAIL_EVENTS[e.type],
            ...id,
            messageId: `email:${e.messageId}:${e.eventId}`,
            timestamp: e.at.endsWith('Z') ? e.at : `${e.at}Z`,
            properties: {
              message_id: e.messageId,
              template_id: e.templateId,
              // The journey (jrn_) or broadcast (bct_) that sent it.
              campaign_id: e.journeyId,
              purpose: e.purpose,
              ...(e.url ? { url: e.url } : {}),
              ...(e.reason ? { reason: e.reason } : {}),
            },
          },
        ];
      });
      if (!items.length) continue;
      const { accepted } = acceptItems(
        items,
        { id: 'email', workspaceId: ws, kind: 'server', requiredPurpose: null },
        await loadPolicy(ws),
      );
      if (accepted.length) await deps.bus.publish(accepted);
    }
  }
  return {
    ...store,
    async insertMessageEvents(events) {
      await store.insertMessageEvents(events);
      // Best effort: the message log is the record; the customer events are derived from it.
      await publish(events).catch((err) => logger.warn({ err }, 'e-mail events not published as customer events'));
    },
  };
}
