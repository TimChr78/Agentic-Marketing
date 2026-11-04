import { DEFAULT_PURPOSES, type Purposes } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { purposeHolds } from '../src';

// #372: a standing refusal in the ledger wins over a per-event consent signal, because the signal
// comes from the public ingest path and can be stale. This is the same ledger-first rule the
// audience sync uses (consentStatusSql) and ADR-0014 requires.
describe('ad_measurement consent precedence', () => {
  it('treats a ledger refusal as final, whatever the event signal says', () => {
    for (const status of ['withdrawn', 'denied', 'objected']) {
      expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', true, status)).toBe(false);
      expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', undefined, status)).toBe(false);
      expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', false, status)).toBe(false);
    }
  });

  it('still accepts an explicit yes for a person with no refusal in the ledger', () => {
    expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', true, undefined)).toBe(true);
    expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', true, 'granted')).toBe(true);
    expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', undefined, 'granted')).toBe(true);
    expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', false, 'granted')).toBe(false);
    expect(purposeHolds(DEFAULT_PURPOSES, 'ad_measurement', undefined, 'pending')).toBe(false);
  });

  it('leaves legitimate-interest purposes refused when the person objected or withdrew', () => {
    const purposes: Purposes = [{ ...DEFAULT_PURPOSES[0], key: 'ad_measurement', basis: 'legitimate_interest' }];
    expect(purposeHolds(purposes, 'ad_measurement', true, undefined)).toBe(true);
    expect(purposeHolds(purposes, 'ad_measurement', true, 'withdrawn')).toBe(false);
    expect(purposeHolds(purposes, 'ad_measurement', false, 'granted')).toBe(false);
  });
});
