// Ad click ids a stored event carries. The list is shared with the ads package (which re-exports
// it) so the subject keys hashed at write time and the identifiers the click-id hook attaches to a
// person can never drift apart.

export const CLICK_ID_TYPES = ['gclid', 'gbraid', 'wbraid', 'fbc', 'fbp', 'msclkid', 'li_fat_id', 'ttclid', 'ttp', 'epik'] as const;

export type ClickIdType = (typeof CLICK_ID_TYPES)[number];
export type ClickIds = Partial<Record<ClickIdType, string>>;

const VALUE = /^[A-Za-z0-9._~-]{4,500}$/;

/** A JSON object, not an array or null: what `context.clickIds` and `context.page` must be. */
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

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

/**
 * Click ids an event carries: `context.clickIds`, or the landing page's query string. `context` is
 * client-supplied JSON, validated as a record of unknown values, so every field is checked for its
 * type: a value of the wrong shape reads as "no click id" instead of throwing, because the sink,
 * the subject-key backfill and the ads hook all read click ids on write. Ingest removes a
 * `clickIds` that is not an object of ids, so the page's own parameters still supply them here.
 */
export function clickIdsOfEvent(context: unknown, seenAt: number): ClickIds {
  const fields = isRecord(context) ? context : {};
  const explicit = fields.clickIds;
  if (isRecord(explicit)) return clickIdsFrom(explicit, seenAt);
  const page = isRecord(fields.page) ? fields.page : undefined;
  const url = typeof page?.url === 'string' ? page.url : undefined;
  const search = typeof page?.search === 'string' ? page.search : url?.includes('?') ? url.slice(url.indexOf('?')) : '';
  return search ? clickIdsFrom(Object.fromEntries(new URLSearchParams(search)), seenAt) : {};
}
