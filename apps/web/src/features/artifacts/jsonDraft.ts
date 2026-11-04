/** Whether a JSON editor's local text should be replaced by an outside `value` change. */
export function shouldSyncJsonText({
  text,
  value,
  documentChanged = false,
}: {
  text: string;
  value: unknown;
  documentChanged?: boolean;
}): boolean {
  // A different artifact replaces the editor's contents even when the old text was invalid.
  if (documentChanged) return true;
  try {
    return JSON.stringify(JSON.parse(text)) !== JSON.stringify(value);
  } catch {
    // Mid-edit text that does not parse yet is the user's work, not a stale copy: never wipe it.
    return false;
  }
}
