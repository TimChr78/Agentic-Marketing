// A process-wide count of journey events the hook refused because they were too old (#1027). The
// hook is called from the profile workers, so the counter lives here and the server's scrape reads
// it, like the subject-key failure count. A steadily rising rate means the event stream is
// redelivering very old messages, or a clock is far behind; it is not an error, because the hook
// acknowledges the event and moves on.
let eventsTooOld = 0;

/** One event delivery that the age bound refused. */
export function noteJourneyEventTooOld(): void {
  eventsTooOld += 1;
}

/** The counter for `am_journey_events_too_old_total`. */
export function journeyEventsTooOldCount(): number {
  return eventsTooOld;
}
