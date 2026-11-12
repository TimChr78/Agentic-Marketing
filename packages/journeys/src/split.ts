// Attribution for journeys.splitResult (#369). A person may legitimately enter a journey more
// than once and land in different arms, and one participant may loop back through the same split.
// Each outcome event must therefore count for exactly one split entry, never for every entry of
// that profile. The rule is:
//
//   1. A conversion recorded for a participant belongs to that participant's (first) split take,
//      provided the take happened at or before the conversion. The participant id is the
//      canonical identity across profile merges: a profile merged after the take keeps the same
//      `journey_participants` row, so the conversion may carry a different (historical or
//      survivor) profile id than the split entry and still belongs to that participant (#419).
//   2. Any outcome without a participant (an e-mail unsubscribe) belongs to the profile's latest
//      split entry at or before the outcome. Equal timestamps are broken by participant id, so
//      the choice is deterministic.
//
// An explicit participant never falls back to another participant's take. If its own take is
// missing, after the outcome, or otherwise not eligible, the outcome is not attributed. Only a
// genuinely participant-less outcome uses the temporal profile fallback (#419).
//
// Entries are already one row per participant: `journeySplitArms` keeps the first split take by
// (at, seq, detail), so a repeated take cannot add a second arm.

export interface SplitEntry {
  participantId: number;
  profileId: string;
  arm: number;
  /** Milliseconds since the epoch, from the split step's timestamp. */
  at: number;
}

export interface SplitOutcome {
  profileId: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** Present for journey conversions; message events (unsubscribes) do not record one. */
  participantId?: number | null;
}

export interface SplitCounts {
  entered: number;
  converted: number;
  unsubscribed: number;
}

/**
 * Counts entrants per arm and attributes every conversion/unsubscribe to exactly one eligible
 * entry. Outcomes before the first eligible entry are ignored rather than attributed backwards.
 */
export function attributeSplitOutcomes(
  entries: SplitEntry[],
  outcomes: { converted: SplitOutcome[]; unsubscribed: SplitOutcome[] },
  armCount: number,
): SplitCounts[] {
  const counts = Array.from({ length: armCount }, () => ({ entered: 0, converted: 0, unsubscribed: 0 }));
  const byParticipant = new Map<number, SplitEntry>();
  const byProfile = new Map<string, SplitEntry[]>();
  for (const entry of entries) {
    if (entry.arm < 0 || entry.arm >= armCount) continue;
    counts[entry.arm].entered++;
    byParticipant.set(entry.participantId, entry);
    const list = byProfile.get(entry.profileId) ?? [];
    list.push(entry);
    byProfile.set(entry.profileId, list);
  }
  for (const list of byProfile.values()) list.sort((a, b) => a.at - b.at || a.participantId - b.participantId);

  const eligible = (outcome: SplitOutcome): SplitEntry | undefined => {
    if (outcome.participantId != null) {
      // The participant id, not the event's historical profile id, is the canonical identity.
      // Never let a missing or too-late own take fall through to a different participant (#419).
      const direct = byParticipant.get(outcome.participantId);
      return direct && direct.at <= outcome.at ? direct : undefined;
    }
    // Latest entry at or before the outcome; the loop keeps the last one, which is the highest
    // participant id at an equal timestamp after sorting.
    let chosen: SplitEntry | undefined;
    for (const entry of byProfile.get(outcome.profileId) ?? []) {
      if (entry.at > outcome.at) break;
      chosen = entry;
    }
    return chosen;
  };

  // Rates use entrant entries as their denominator, so repeated outcome events for the
  // same entry count once. Re-entry can still contribute once for each distinct participant.
  const converted = new Set<number>();
  for (const outcome of outcomes.converted) {
    const entry = eligible(outcome);
    if (entry && !converted.has(entry.participantId)) {
      converted.add(entry.participantId);
      counts[entry.arm].converted++;
    }
  }
  const unsubscribed = new Set<number>();
  for (const outcome of outcomes.unsubscribed) {
    const entry = eligible(outcome);
    if (entry && !unsubscribed.has(entry.participantId)) {
      unsubscribed.add(entry.participantId);
      counts[entry.arm].unsubscribed++;
    }
  }
  return counts;
}

/**
 * Distinct people per split arm. The k-anonymity floor counts people, not entries: one person who
 * re-enters an arm several times is still one person (0.14.11 review, #757).
 */
export function splitArmPeople(entries: readonly { profileId: string; arm: number }[], armCount: number): number[] {
  const people = Array.from({ length: armCount }, () => new Set<string>());
  for (const entry of entries) if (entry.arm >= 0 && entry.arm < armCount) people[entry.arm]!.add(entry.profileId);
  return people.map((set) => set.size);
}
