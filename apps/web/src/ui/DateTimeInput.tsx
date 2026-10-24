import { Input } from './form';
import { getWorkspaceTimeZone, isoToWallTime, wallTimeToIso } from './time';

/**
 * A date-time picker in the workspace time zone (#51). `value` and `onChange` use ISO 8601 with
 * an explicit offset, which is what the API expects; the zone is shown next to the control.
 */
export function DateTimeInput({ value, onChange, zone = getWorkspaceTimeZone(), min, ...p }: { value: string | null; onChange: (iso: string | null) => void; zone?: string; min?: string; id?: string; disabled?: boolean; onBlur?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Input type="datetime-local" value={isoToWallTime(value, zone)} min={min ? isoToWallTime(min, zone) : undefined} onChange={(e) => onChange(e.target.value ? wallTimeToIso(e.target.value, zone) : null)} className="max-w-[240px]" {...p} />
      <span className="text-[12px] whitespace-nowrap text-muted">{zone}</span>
    </div>
  );
}
