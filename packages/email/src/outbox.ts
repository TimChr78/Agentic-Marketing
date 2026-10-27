import { schema, type Tx } from '@agentic-marketing/db';
import type { MessageEvent } from '@agentic-marketing/events';
import { eq } from 'drizzle-orm';

// Shared by the e-mail and SMS delivery paths.

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

export function decisionEvent(
  m: typeof schema.messages.$inferSelect,
  type: MessageEvent['type'],
  reason = '',
  provider = '',
): MessageEvent {
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
