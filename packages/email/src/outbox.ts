import { hashValue } from '@agentic-marketing/core';
import { enqueueOutbox, schema, type Tx } from '@agentic-marketing/db';
import type { MessageEvent } from '@agentic-marketing/events';
import { eq } from 'drizzle-orm';

// Shared by the e-mail and SMS delivery paths.

/**
 * Writes message events to the transactional outbox in the caller's transaction (#978 part 2), so
 * a decision is durable before its transaction commits and ClickHouse never runs under a lock. The
 * dispatcher publishes them. The operation key is the set of event identities and their broadcast
 * or journey: a redelivery of the same action adds no second row, and ClickHouse collapses a
 * duplicate on (message, type, event id).
 */
export async function enqueueMessageEvents(tx: Tx, workspaceId: string, events: MessageEvent[]): Promise<void> {
  if (!events.length) return;
  // One row per broadcast or journey (#1038). A provider webhook batch can span several of them,
  // and the publication barrier can only filter on `subject_ref`: a batch written as one
  // unsubjected row is invisible, so a canary check or subject-test winner could decide while its
  // clicks or unsubscribes were still queued. Events with no subject (a direct send) keep a null
  // `subject_ref`. Each group keeps its own stable operation key, so a redelivery still adds no
  // second row and every row is delivered at least once on its own.
  const bySubject = new Map<string | null, MessageEvent[]>();
  for (const event of events) {
    const subject = event.journeyId || null;
    const group = bySubject.get(subject);
    if (group) group.push(event);
    else bySubject.set(subject, [event]);
  }
  for (const [subject, group] of bySubject) {
    const identities = group.map((e) => `${e.messageId}:${e.type}:${e.eventId}`).sort();
    await enqueueOutbox(tx, workspaceId, {
      kind: 'message_event',
      operationKey: `message-event:${hashValue({ subject, events: identities })}`,
      ...(subject ? { subjectRef: subject } : {}),
      // The time the batch is queued travels with it (#1027): the dispatcher publishes the carrier
      // events with this receive time, so a row retried or requeued days later keeps its delivery
      // age instead of looking fresh to the journey hook. The operation key does not include it, so
      // a redelivery of the same events still adds no second row.
      payload: { events: group, receivedAt: new Date().toISOString() },
    });
  }
}

export const MAX_ATTEMPTS = 4;

// Seconds before the next attempt after 1, 2, 3 … failures. Transactional and onboarding mail
// (confirmations, account notices) is retried quickly because someone is waiting; marketing keeps
// the slower backoff that grows with attempts, for deliverability. After the table, both fall
// back to 30 × attempts² seconds.
const RETRY_SECONDS = {
  transactional: [10, 30, 60, 120],
  marketing: [],
} as const;

export function retryDelaySeconds(stream: 'marketing' | 'transactional', attempts: number): number {
  return RETRY_SECONDS[stream][attempts - 1] ?? 30 * attempts * attempts;
}

/**
 * The message fields a decision event records, so a caller that settles a row can select only
 * these instead of the whole row (the stale sweep only needs them to write its event).
 */
export type DecisionMessage = Pick<
  typeof schema.messages.$inferSelect,
  'workspaceId' | 'id' | 'attempts' | 'profileId' | 'channel' | 'purpose' | 'templateId' | 'templateVersion' | 'journeyId' | 'variant'
>;

export function decisionEvent(m: DecisionMessage, type: MessageEvent['type'], reason = '', provider = ''): MessageEvent {
  return {
    workspaceId: m.workspaceId,
    messageId: m.id,
    eventId: `decision:${type}:${m.attempts}`,
    type,
    at: new Date().toISOString(),
    profileId: m.profileId ?? '',
    channel: m.channel,
    purpose: m.purpose,
    provider,
    templateId: m.templateId ?? '',
    templateVersion: m.templateVersion ?? 0,
    journeyId: m.journeyId ?? '',
    variant: m.variant ?? '',
    reason,
    url: '',
  };
}

/** Puts a claimed message back until `until`; holding it back is not a failed attempt. */
export async function defer(tx: Tx, m: typeof schema.messages.$inferSelect, until: Date, reason: string) {
  await tx
    .update(schema.messages)
    .set({ status: 'queued', reason, notBefore: until, attempts: Math.max(0, m.attempts - 1), updatedAt: new Date() })
    .where(eq(schema.messages.id, m.id));
  return { kind: 'done' as const, event: { ...decisionEvent(m, 'queued', reason), eventId: `decision:held:${until.toISOString()}` } };
}
