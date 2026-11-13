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
 * The live state of one reference: the snapshot, the order number of the observation it came from
 * (a counter shared by watcher reads and estimates, taken when each request starts), and whether
 * the latest attempt to re-check it failed.
 */
export interface LiveReference extends ReferenceSnapshot {
  seq: number;
  unverified: boolean;
}

/**
 * One observation merged into a reference's live state (0.14.13 review rounds 3 and 4):
 * - a failed read (`undefined`) keeps the snapshot but marks it unverified, if the read started
 *   after the live observation; an older failure says nothing about it;
 * - two published observations: the newer (version, stamp) wins whatever the order, so a slow
 *   read cannot pull an adopted stamp backwards;
 * - an unpublished observation (`version: null`) carries no version to compare, so it replaces the
 *   live state only when it started after it: a stale "unpublished" cannot undo a later republish.
 * A successful observation that started after the live one clears `unverified`.
 */
export function mergeObservation(live: LiveReference | undefined, observed: ReferenceSnapshot | undefined, seq: number): LiveReference {
  if (!observed) {
    if (!live) return { version: null, stamp: null, seq, unverified: true };
    return seq > live.seq ? { ...live, seq, unverified: true } : live;
  }
  if (!live) return { ...observed, seq, unverified: false };
  const later = seq > live.seq;
  if (observed.version !== null && live.version !== null) {
    const newer = newerSnapshot(live, observed);
    return {
      version: newer.version,
      stamp: newer.stamp,
      seq: Math.max(seq, live.seq),
      unverified: later ? false : live.unverified,
    };
  }
  return later ? { ...observed, seq, unverified: false } : live;
}

/** A watcher read merged into the live state; references the segment no longer uses are dropped. */
export function mergeReferenceSnapshots(
  live: Record<string, LiveReference>,
  read: Record<string, ReferenceSnapshot | undefined>,
  seq: number,
): Record<string, LiveReference> {
  const next: Record<string, LiveReference> = {};
  for (const [id, observed] of Object.entries(read)) next[id] = mergeObservation(live[id], observed, seq);
  return next;
}
