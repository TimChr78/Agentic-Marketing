// Time helpers. Date-times are shown in the workspace time zone (Settings → Workspace) and sent to
// the API as ISO 8601 with an explicit offset (#51).

let workspaceZone: string | undefined;
export function setWorkspaceTimeZone(tz: string | undefined) {
  workspaceZone = tz || undefined;
}
export function getWorkspaceTimeZone(): string {
  return workspaceZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

export function formatDateTime(iso: string | null | undefined, opts: { seconds?: boolean; zone?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: getWorkspaceTimeZone(),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: opts.seconds ? '2-digit' : undefined,
    timeZoneName: opts.zone ? 'short' : undefined,
  }).format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, { timeZone: getWorkspaceTimeZone(), year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))} min`;
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} d`;
  }
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return formatDate(iso);
}

/** The offset of `zone` at instant `utcMs`, in minutes (east positive). */
export function zoneOffsetMinutes(zone: string, utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
function offsetString(min: number) {
  return `${min < 0 ? '-' : '+'}${pad(Math.trunc(min / 60))}:${pad(min % 60)}`;
}

/** "2026-10-24T09:00" wall time in `zone` → "2026-10-24T09:00:00+02:00". Null when the input is not a date-time. */
export function wallTimeToIso(local: string, zone = getWorkspaceTimeZone()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Two passes handle DST boundaries: the offset at the guessed instant, then at the corrected one.
  let off = zoneOffsetMinutes(zone, guess);
  off = zoneOffsetMinutes(zone, guess - off * 60000);
  return `${local}:00${offsetString(off)}`;
}

/** ISO instant → "YYYY-MM-DDTHH:mm" wall time in `zone` (the value of a datetime-local input). */
export function isoToWallTime(iso: string | null | undefined, zone = getWorkspaceTimeZone()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + zoneOffsetMinutes(zone, ms) * 60000);
  return d.toISOString().slice(0, 16);
}
