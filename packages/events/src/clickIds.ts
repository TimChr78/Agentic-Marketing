// Ad click ids a stored event carries. The list is shared with the ads package (which re-exports
// it) so the subject keys hashed at write time and the identifiers the click-id hook attaches to a
// person can never drift apart.

export const CLICK_ID_TYPES = ['gclid', 'gbraid', 'wbraid', 'fbc', 'fbp', 'msclkid', 'li_fat_id', 'ttclid', 'ttp', 'epik'] as const;

export type ClickIdType = (typeof CLICK_ID_TYPES)[number];
export type ClickIds = Partial<Record<ClickIdType, string>>;

const VALUE = /^[A-Za-z0-9._~-]{4,500}$/;

/**
 * Click ids from landing-page parameters (gclid, gbraid, wbraid, fbclid, msclkid, li_fat_id, ttclid,
 * epik) or already named ones (fbc, fbp, ttp, as the platforms' cookies hold them). `fbclid` becomes
 * an `fbc` in Meta's format, fb.1.<first seen, ms>.<fbclid>.
 */
export function clickIdsFrom(params: Record<string, unknown>, seenAt = Date.now()): ClickIds {
  const out: ClickIds = {};
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  for (const type of CLICK_ID_TYPES) if (VALUE.test(str(type))) out[type] = str(type);
  if (!out.fbc && VALUE.test(str('fbclid'))) out.fbc = `fb.1.${seenAt}.${str('fbclid')}`;
  return out;
}

/** Click ids an event carries: `context.clickIds`, or the landing page's query string. */
export function clickIdsOfEvent(context: Record<string, unknown>, seenAt: number): ClickIds {
  const explicit = context.clickIds;
  if (explicit && typeof explicit === 'object') return clickIdsFrom(explicit as Record<string, unknown>, seenAt);
  const page = context.page as { url?: string; search?: string } | undefined;
  const search = page?.search ?? (page?.url?.includes('?') ? page.url.slice(page.url.indexOf('?')) : '');
  return search ? clickIdsFrom(Object.fromEntries(new URLSearchParams(search)), seenAt) : {};
}
