import type { journeyNodeConfigs } from '@agentic-marketing/artifacts';
import { schema, type Tx } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';

// Entry keys (#93): an event-triggered journey can identify "the same thing" by a business key
// such as order_id instead of the ingestion message id. The key is scoped to the journey by the
// participants' partial unique index; a second event with the same key is a duplicate.

export type Trigger = z.output<typeof journeyNodeConfigs.trigger>;

export interface EntryKeyChoice {
  key: string;
  source: 'message_id' | 'event_property';
}

/** Trim strings, stringify numbers, and treat empty or oversized values as missing. */
export function normalizeEntryKey(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

/** Reads a dot path from event properties, e.g. "order" → "order.id". */
export function propertyAt(properties: Record<string, unknown>, path: string): unknown {
  let value: unknown = properties;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * The key this event would enter with, or null when a configured property is missing and the
 * trigger says to skip it. A message-id trigger keeps the old behaviour: one key per delivery.
 */
export function resolveEntryKey(trigger: Trigger, event: Pick<BusEvent, 'messageId' | 'properties'>): EntryKeyChoice | null {
  if (!trigger.event || trigger.entryKey?.source !== 'event_property') return { key: event.messageId, source: 'message_id' };
  const property = trigger.entryKey.property;
  if (!property) return trigger.entryKey.onMissing === 'message_id' ? { key: event.messageId, source: 'message_id' } : null;
  const value = normalizeEntryKey(propertyAt(event.properties, property));
  if (value) return { key: `prop:${property}:${value}`, source: 'event_property' };
  return trigger.entryKey.onMissing === 'message_id' ? { key: event.messageId, source: 'message_id' } : null;
}

/** Whether an earlier participant with this key suppresses the entry under the re-entry rule. */
export async function duplicateEntryKey(tx: Tx, journeyId: string, entryKey: string, reentry: Trigger['reentry']): Promise<boolean> {
  if (reentry === 'always') return false;
  const [prior] = await tx
    .select({ id: schema.journeyParticipants.id })
    .from(schema.journeyParticipants)
    .where(
      and(
        eq(schema.journeyParticipants.journeyId, journeyId),
        eq(schema.journeyParticipants.entryKey, entryKey),
        reentry === 'after_exit' ? inArray(schema.journeyParticipants.status, ['ready', 'waiting']) : undefined,
      ),
    )
    .limit(1);
  return !!prior;
}

/** Counts why an event did not enter, next to the journey's live stats. */
export async function noteEntrySkip(tx: Tx, workspaceId: string, journeyId: string, reason: 'duplicate' | 'missing') {
  const duplicate = reason === 'duplicate' ? 1 : 0;
  const missing = reason === 'missing' ? 1 : 0;
  await tx
    .insert(schema.journeyEntrySkips)
    .values({ workspaceId, journeyId, duplicatesSkipped: duplicate, missingKeySkipped: missing })
    .onConflictDoUpdate({
      target: [schema.journeyEntrySkips.workspaceId, schema.journeyEntrySkips.journeyId],
      set: {
        duplicatesSkipped: sql`${schema.journeyEntrySkips.duplicatesSkipped} + ${duplicate}`,
        missingKeySkipped: sql`${schema.journeyEntrySkips.missingKeySkipped} + ${missing}`,
        updatedAt: new Date(),
      },
    });
}
