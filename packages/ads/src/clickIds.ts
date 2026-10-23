import type { Purposes } from '@agentic-marketing/artifacts';
import type { ClickIdType } from '@agentic-marketing/db';

// Ad click ids (performance-marketing.md, "Data model"). A click id is pseudonymous, but it
// links a visit to an ad platform's knowledge of the person, so it is kept only with the
// `ad_measurement` purpose allowed.

export const CLICK_ID_TYPES: ClickIdType[] = ['gclid', 'gbraid', 'wbraid', 'fbc', 'fbp', 'msclkid', 'li_fat_id', 'ttclid', 'ttp', 'epik'];
export type ClickIds = Partial<Record<ClickIdType, string>>;

const VALUE = /^[A-Za-z0-9._~-]{4,500}$/;

/**
 * Click ids from landing-page parameters (gclid, gbraid, wbraid, fbclid, msclkid, li_fat_id, ttclid,
 * epik) or already named ones (fbc, fbp, ttp, as the platforms' cookies hold them). `fbclid` becomes an `fbc` in Meta's format,
 * fb.1.<first seen, ms>.<fbclid>.
 */
export function clickIdsFrom(params: Record<string, unknown>, seenAt = Date.now()): ClickIds {
  const out: ClickIds = {};
  const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string).trim() : '');
  for (const t of ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbc', 'fbp', 'li_fat_id', 'ttclid', 'ttp', 'epik'] as const)
    if (VALUE.test(str(t))) out[t] = str(t);
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

/** Google Consent Mode v2 signals for our purposes. */
export function googleConsentMode(allowed: (purpose: string) => boolean) {
  const g = (b: boolean) => (b ? 'granted' : 'denied');
  return {
    analytics_storage: g(allowed('analytics')),
    ad_storage: g(allowed('ad_measurement') || allowed('ad_targeting')),
    ad_user_data: g(allowed('ad_measurement')),
    ad_personalization: g(allowed('ad_targeting')),
  };
}

/** Whether a purpose holds given a signal and the ledger: consent needs a yes, other bases hold unless objected to. */
export function purposeHolds(purposes: Purposes, key: string, signal: boolean | undefined, ledger: string | undefined) {
  const basis = purposes.find((p) => p.key === key)?.basis ?? 'consent';
  if (basis === 'consent') return signal === true || (signal === undefined && ledger === 'granted');
  return signal !== false && ledger !== 'objected' && ledger !== 'withdrawn' && ledger !== 'denied';
}
