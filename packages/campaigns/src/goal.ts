/**
 * The goal event(s) of a campaign, shared by the analytics builder and the holdout result.
 *
 * A revenue goal reads its value and currency from the published conversion map, so the map's
 * events count as conversions; the campaign's own `goal.event` always counts too, even when no
 * map is published or the map does not name it (#632). Other goals count exactly the event the
 * campaign names.
 */
export interface GoalEventSource {
  kind: string;
  event?: string | null;
}

export function goalEventsFor(goal: GoalEventSource, conversionMapEvents: readonly string[]): string[] {
  if (goal.kind === 'revenue' && conversionMapEvents.length)
    return [...new Set([...conversionMapEvents, ...(goal.event ? [goal.event] : [])])];
  return goal.event ? [goal.event] : [];
}
