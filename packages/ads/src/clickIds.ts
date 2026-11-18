import type { Purposes } from '@agentic-marketing/artifacts';
import { REFUSALS } from '@agentic-marketing/profiles';

// Ad click ids (performance-marketing.md, "Data model"). A click id is pseudonymous, but it
// links a visit to an ad platform's knowledge of the person, so it is kept only with the
// `ad_measurement` purpose allowed. The list and the extraction live in the events package, so the
// subject keys a stored row keeps use exactly the ids the click-id hook attaches to a person.
export { CLICK_ID_TYPES, type ClickIds, clickIdsFrom, clickIdsOfEvent } from '@agentic-marketing/events';

/** Whether a consent status is a refusal (withdrawn, denied, objected). */
export const isRefusal = (status: string | undefined) => !!status && (REFUSALS as readonly string[]).includes(status);

/**
 * Whether a purpose holds given a signal and the ledger. A refusal in the ledger is final: the
 * event's signal is client-controlled (stale CMP state, a replayed batch) and can never override
 * a standing withdrawal. Never-recorded people may still be covered by an explicit yes.
 */
export function purposeHolds(purposes: Purposes, key: string, signal: boolean | undefined, ledger: string | undefined) {
  const basis = purposes.find((p) => p.key === key)?.basis ?? 'consent';
  if (isRefusal(ledger)) return false;
  if (basis === 'consent') return signal === true || (signal === undefined && ledger === 'granted');
  return signal !== false;
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
