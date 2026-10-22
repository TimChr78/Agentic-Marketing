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
