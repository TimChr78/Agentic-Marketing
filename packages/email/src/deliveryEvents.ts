import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { schema, type Tx } from '@agentic-marketing/db';
import type { MessageEvent } from '@agentic-marketing/events';
import { profileForMessage, recordConsent } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import type { DeliveryEvent } from './adapters';

// What providers report about messages (webhooks, or the send response itself): the message log,
// suppressions for hard bounces and complaints, and consent for unsubscribes.

export type Msg = typeof schema.messages.$inferSelect;
const STATUS_ORDER = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained'];

export function messageEvent(
  m: Msg,
  e: Pick<MessageEvent, 'eventId' | 'type' | 'at'> & Partial<MessageEvent>,
  provider: string,
): MessageEvent {
  return {
    workspaceId: m.workspaceId,
    messageId: m.id,
    profileId: m.profileId ?? '',
    channel: m.channel,
    purpose: m.purpose,
    provider,
    templateId: m.templateId ?? '',
    templateVersion: m.templateVersion ?? 0,
    journeyId: m.journeyId ?? '',
    variant: m.variant ?? '',
    reason: '',
    url: '',
    ...e,
  };
}

export async function withdraw(tx: Tx, m: Msg, source: 'unsubscribe', proof: Record<string, unknown>, kp: KeyProvider) {
  if (!m.profileId) return;
  const person = await profileForMessage(tx, m.workspaceId, m.profileId, kp);
  if (!person) return;
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const basis = purposes.find((p) => p.key === m.purpose)?.basis ?? 'consent';
  // Under legitimate interest an unsubscribe is an objection; under consent, a withdrawal.
  await recordConsent(tx, m.workspaceId, person.id, purposes, [
    { purpose: m.purpose, channel: m.channel, status: basis === 'legitimate_interest' ? 'objected' : 'withdrawn', source, proof },
  ]);
}

/** Applies a provider's delivery events to the message log, suppressions and consent. */
export async function applyDeliveryEvents(tx: Tx, events: DeliveryEvent[], provider: string, kp: KeyProvider): Promise<MessageEvent[]> {
  const out: MessageEvent[] = [];
  for (const e of events) {
    const [m] = e.messageId
      ? await tx.select().from(schema.messages).where(eq(schema.messages.id, e.messageId))
      : e.providerMessageId
        ? await tx.select().from(schema.messages).where(eq(schema.messages.providerMessageId, e.providerMessageId))
        : [];
    if (!m) {
      logger.warn({ provider, event: e.type, providerMessageId: e.providerMessageId }, 'delivery event for an unknown message');
      continue;
    }
    const at = e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
    // Test sends never enter reporting or change consent. Their status and suppressions still count.
    if (!m.test)
      out.push(
        messageEvent(
          m,
          { eventId: e.eventId, type: e.type, at, reason: e.reason ?? (e.bounce ? `${e.bounce} bounce` : ''), url: e.url ?? '' },
          provider,
        ),
      );

    const next =
      e.type === 'delivered'
        ? 'delivered'
        : e.type === 'bounced' && e.bounce === 'hard'
          ? 'bounced'
          : e.type === 'complained'
            ? 'complained'
            : null;
    if (next && STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(m.status))
      await tx
        .update(schema.messages)
        .set({ status: next, reason: e.reason ?? m.reason, updatedAt: new Date() })
        .where(eq(schema.messages.id, m.id));
    if (m.recipientHash && ((e.type === 'bounced' && e.bounce === 'hard') || e.type === 'complained'))
      await tx
        .insert(schema.suppressions)
        .values({
          workspaceId: m.workspaceId,
          channel: m.channel,
          valueHash: m.recipientHash,
          reason: e.type === 'complained' ? 'complaint' : 'hard_bounce',
        })
        .onConflictDoNothing();
    if (!m.test && (e.type === 'complained' || e.type === 'unsubscribed'))
      await withdraw(tx, m, 'unsubscribe', { messageId: m.id, via: `${provider} ${e.type}` }, kp);
  }
  return out;
}
