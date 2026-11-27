// What the ClickHouse sink and the erasure filter read from a queued record, and the legacy values
// they can still recover. A record that cannot be read deterministically is dropped instead of
// failing its whole batch on every redelivery; a dependency failure is never decided here.

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The record's maps, in the order the diagnostics name them. */
const MAP_FIELDS = ['properties', 'traits', 'piiTraits', 'context'] as const;

/**
 * Fills the values an older queued record may carry with the defaults the writer already uses:
 * an absent map is an empty one, and a `null` profile or previous id is no id (the writer stores
 * `''`). Only values the reader and the writer treat the same way are recovered; anything else is
 * left for `unreadableEventReason` to judge.
 */
export function normalizeEvent(event: unknown): void {
  if (!isRecord(event)) return;
  for (const field of MAP_FIELDS) if (event[field] === undefined || event[field] === null) event[field] = {};
  if (event.consent === undefined || event.consent === null) event.consent = {};
  if (event.profileId === null) delete event.profileId;
  if (event.previousId === null) delete event.previousId;
}

/**
 * Why the store and the erasure filter cannot read this event, or `null` when every field they use
 * has a type they can use. A record like this cannot become readable on another delivery, so the
 * sink drops it rather than failing the batch (which would hold back every other tenant's events
 * until the stream's max age). The reason is a field name or a fixed label, never its value.
 *
 * Only the fields those two readers touch are checked. `groupId`, for example, is read by neither,
 * so a record carrying it in another shape is still stored.
 */
export function unreadableEventReason(event: unknown): string | null {
  if (!isRecord(event)) return 'event';
  for (const field of ['workspaceId', 'sourceId', 'messageId', 'type', 'name', 'anonymousId', 'userId', 'timestamp', 'receivedAt'])
    if (typeof event[field] !== 'string') return field;
  // The erasure filter casts this to `uuid[]`; another shape would fail its whole batch every time.
  if (!UUID.test(event.workspaceId as string)) return 'workspaceId';
  for (const field of MAP_FIELDS) if (!isRecord(event[field])) return field;
  if (!isRecord(event.consent) || Object.values(event.consent).some((value) => typeof value !== 'boolean')) return 'consent';
  for (const field of ['profileId', 'previousId'])
    if (event[field] !== undefined && event[field] !== null && typeof event[field] !== 'string') return field;
  // A timestamp ClickHouse cannot parse would make it reject the whole insert on every retry.
  if (Number.isNaN(Date.parse(event.timestamp as string))) return 'timestamp';
  if (Number.isNaN(Date.parse(event.receivedAt as string))) return 'receivedAt';
  return null;
}

/** The safe correlation fields of a record: its workspace and event id, never its payload. */
export function eventCorrelation(event: unknown) {
  const fields = isRecord(event) ? event : {};
  return {
    workspaceId: typeof fields.workspaceId === 'string' ? fields.workspaceId : undefined,
    eventId: typeof fields.messageId === 'string' ? fields.messageId : undefined,
  };
}
