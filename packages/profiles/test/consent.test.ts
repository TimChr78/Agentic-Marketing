import type { Purposes } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { type ConsentRow, consentProofFor, currentConsent, purposeAllowed, refusedPurposes } from '../src/consent';
import { CASES, P, row } from './consentCases';

// The one rule for "current status of a purpose" (ADR 0014), as every reader applies it.

const status = (rows: ConsentRow[], channel?: string) => currentConsent(rows, P, channel)?.status;

describe('currentConsent', () => {
  for (const c of CASES)
    it(c.name, () => {
      expect(status(c.rows)).toBe(c.any);
      expect(status(c.rows, 'email')).toBe(c.email);
    });

  it('for a channel, is the newest of the all-channels and that channel’s row (the send gateway, unchanged)', () => {
    const rows = [row('', 'granted', 1), row('email', 'withdrawn', 2), row('', 'granted', 3)];
    expect(status(rows, 'email')).toBe('granted');
    expect(status([row('', 'granted', 3), row('email', 'withdrawn', 2)], 'sms')).toBe('granted');
  });

  it('feeds purposeAllowed for each basis', () => {
    const unsubscribed = currentConsent([row('', 'granted', 1), row('email', 'objected', 2)], P)?.status;
    expect(purposeAllowed('consent', unsubscribed)).toBe(false);
    expect(purposeAllowed('legitimate_interest', unsubscribed)).toBe(false);
    expect(purposeAllowed('legitimate_interest', undefined)).toBe(true);
    expect(purposeAllowed('contract', unsubscribed)).toBe(true);
  });
});

describe('consentProofFor (Sol 0.14.2 review)', () => {
  it('withholds an allowlisted string that carries an e-mail address', () => {
    expect(consentProofFor({ import_label: 'ada@example.com', system: 'Kit' }, false)).toEqual({
      proof: { system: 'Kit' },
      proofWithheld: true,
    });
  });

  it('withholds an allowlisted string that carries a phone number', () => {
    expect(consentProofFor({ import_label: '+45 12 34 56 78' }, false)).toEqual({ proof: {}, proofWithheld: true });
  });

  it('returns the same values in full to a role with profiles:pii', () => {
    const proof = { import_label: 'ada@example.com', system: 'Kit' };
    expect(consentProofFor(proof, true)).toEqual({ proof, proofWithheld: false });
  });

  it('keeps non-personal allowlisted values and reports nothing withheld', () => {
    expect(consentProofFor({ import_label: 'privacy ledger test', form_id: 'frm_1' }, false)).toEqual({
      proof: { import_label: 'privacy ledger test', form_id: 'frm_1' },
      proofWithheld: false,
    });
  });
});

describe('refusedPurposes (journeys exit on these, #108)', () => {
  const purpose = (key: string, basis: Purposes[number]['basis']) =>
    ({ key, name: key, description: '', basis, channels: ['email'], requiresDoubleOptIn: false }) as Purposes[number];
  const purposes = [purpose(P, 'consent'), purpose('news', 'legitimate_interest'), purpose('onboarding', 'contract')];

  it('is a purpose whose current status without a channel is a refusal', () => {
    expect(refusedPurposes([row('', 'granted', 1), row('email', 'withdrawn', 2)], purposes)).toEqual([P]);
    expect(refusedPurposes([row('', 'granted', 1), row('email', 'objected', 2, 'news')], purposes)).toEqual(['news']);
  });

  it('is not a purpose consented to again, or not consented to yet', () => {
    expect(refusedPurposes([row('email', 'withdrawn', 1), row('', 'granted', 2)], purposes)).toEqual([]);
    expect(refusedPurposes([], purposes)).toEqual([]);
  });

  it('a channel grant does not lift an all-channels refusal (ADR 0014)', () => {
    expect(refusedPurposes([row('', 'withdrawn', 1), row('email', 'granted', 2)], purposes)).toEqual([P]);
  });

  it('never a contract purpose, which a refusal does not stop', () => {
    expect(refusedPurposes([row('', 'denied', 1, 'onboarding')], purposes)).toEqual([]);
  });
});
