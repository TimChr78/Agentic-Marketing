import { useEffect, useState } from 'react';

// Held agent changes (ADR-0016, #225/#228): a request with `holdUntil` runs at that time unless a
// person vetoes it. The inbox shows a live countdown and offers "Run now" or "Veto".

/** "1 h 12 min", "12 min", "under a minute", "2 d 3 h" — the time left, in words. */
export function formatHoldCountdown(holdUntil: string, now = Date.now()): string {
  const ms = new Date(holdUntil).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'any moment now';
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? '1 min' : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/** The sentence the inbox shows for a held request, e.g. "Runs in 1 h 12 min unless rejected". */
export function holdCountdownText(holdUntil: string, now = Date.now()): string {
  return `Runs in ${formatHoldCountdown(holdUntil, now)} unless rejected`;
}

/** Re-renders on an interval so a countdown moves; the default minute is enough for "1 h 12 min". */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** True when a hold is due now (the server's hold runner takes over). */
export function holdIsDue(holdUntil: string, now = Date.now()): boolean {
  return new Date(holdUntil).getTime() <= now;
}
