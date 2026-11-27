/**
 * True when a segment rule can involve message engagement, including through a referenced segment
 * whose definition is not loaded here. Message leaves make membership move only at the next
 * scheduled refresh, not as messages arrive (#1078, #1264).
 */
export function containsMessage(condition: unknown): boolean {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition)) return condition.some(containsMessage);
  const c = condition as Record<string, unknown>;
  if (typeof c.message === 'string') return true;
  if (typeof c.segment === 'string') return true;
  if (Array.isArray(c.all) && c.all.some(containsMessage)) return true;
  if (Array.isArray(c.any) && c.any.some(containsMessage)) return true;
  return 'not' in c && containsMessage(c.not);
}
