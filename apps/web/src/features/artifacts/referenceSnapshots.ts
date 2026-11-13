/** One observation of a referenced segment: its published version and its list membership stamp. */
export interface ReferenceSnapshot {
  version: number | null;
  stamp: string | null;
}

/**
 * The newer of two observations of one reference. Versions are integers and stamps are increasing
 * microsecond timestamps (`YYYY-MM-DDTHH:MM:SS.ffffffZ`, so text order is time order); a missing
 * version or stamp is older than a present one. Equal states return the first, which is the live
 * one already held.
 */
export function newerSnapshot(a: ReferenceSnapshot, b: ReferenceSnapshot): ReferenceSnapshot {
  if (a.version !== b.version) {
    if (a.version === null) return b;
    if (b.version === null) return a;
    return a.version > b.version ? a : b;
  }
  if (a.stamp === b.stamp) return a;
  if (a.stamp === null) return b;
  if (b.stamp === null) return a;
  return a.stamp > b.stamp ? a : b;
}

/**
 * A watcher read merged into the live state (0.14.13 review round 3). For each reference the read
 * says:
 * - `undefined` (the read failed): keep the live snapshot;
 * - no published version: the segment was unpublished, which is a change, so take the read;
 * - otherwise the newer of live and read, so a read that answers after an estimate adopted a newer
 *   stamp cannot pull the state backwards.
 * References missing from the read (no longer used by the segment) are dropped.
 */
export function mergeReferenceSnapshots(
  live: Record<string, ReferenceSnapshot>,
  read: Record<string, ReferenceSnapshot | undefined>,
): Record<string, ReferenceSnapshot> {
  const next: Record<string, ReferenceSnapshot> = {};
  for (const [id, snapshot] of Object.entries(read)) {
    const current = live[id];
    if (!snapshot) {
      if (current) next[id] = current;
      continue;
    }
    next[id] = !current || snapshot.version === null ? snapshot : newerSnapshot(current, snapshot);
  }
  return next;
}
