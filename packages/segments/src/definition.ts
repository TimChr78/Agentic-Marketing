import { artifactTypes, durationSeconds, MAX_DURATION_SECONDS, type SegmentDefinition } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import type { ZodError } from 'zod';

// Reading a saved segment definition. A definition an older release accepted can stop parsing when
// the schema tightens (the 10-year window cap of #1073 is the current case). Every caller that
// parses saved content answers that with `invalid_input` and the fix, never a raw ZodError (a 500
// with no advice); stored membership stays readable because `segments.members` reads the raw mode.

/** The refusal for content that does not parse: say it is old and how to fix it. */
export function invalidDefinitionError(raw: unknown, error: ZodError): AppError {
  if (hasOverlongWindow((raw as { condition?: unknown } | null)?.condition))
    return new AppError('invalid_input', 'This segment has a window longer than 10 years; re-save it with a window of at most 10 years');
  return new AppError(
    'invalid_input',
    `This segment's saved definition is from an older release and can no longer be read: ${error.issues[0]?.message ?? 'it does not match the schema'}. Re-save it to continue.`,
  );
}

/** A saved segment definition, or the clean `invalid_input` refusal above. */
export function parseSegmentDefinition(raw: unknown): SegmentDefinition {
  const parsed = artifactTypes.segment.content.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw invalidDefinitionError(raw, parsed.error);
}

/** Whether a condition names a look-back longer than ClickHouse can bind (the schema's 10-year cap). */
function hasOverlongWindow(condition: unknown): boolean {
  let found = false;
  const walk = (node: unknown) => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const c = node as Record<string, unknown>;
    if (typeof c.within === 'string' && durationSeconds(c.within) > MAX_DURATION_SECONDS) found = true;
    if (Array.isArray(c.all)) for (const child of c.all) walk(child);
    if (Array.isArray(c.any)) for (const child of c.any) walk(child);
    if (c.not) walk(c.not);
  };
  walk(condition);
  return found;
}
