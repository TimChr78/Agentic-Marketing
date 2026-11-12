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
      proof: { import_label: 'Imported', system: 'Kit' },
      proofWithheld: true,
    });
  });

  it('withholds an allowlisted string that carries a phone number', () => {
    expect(consentProofFor({ import_label: '+45 12 34 56 78' }, false)).toEqual({
      proof: { import_label: 'Imported' },
      proofWithheld: true,
    });
  });

  it('replaces a free-text import label for a role without profiles:pii (#672)', () => {
    // A name cannot be detected as personal data, so the label text is never shown.
    const result = consentProofFor({ import_label: 'Alice Smith', system: 'Kit' }, false);
    expect(result).toEqual({ proof: { import_label: 'Imported', system: 'Kit' }, proofWithheld: true });
    expect(JSON.stringify(result)).not.toContain('Alice Smith');
  });

  it('returns the same values in full to a role with profiles:pii', () => {
    const proof = { import_label: 'ada@example.com', system: 'Kit' };
    expect(consentProofFor(proof, true)).toEqual({ proof, proofWithheld: false });
  });

  it('keeps the import label for a role with profiles:pii (#672)', () => {
    const proof = { import_label: 'Alice Smith' };
    expect(consentProofFor(proof, true)).toEqual({ proof, proofWithheld: false });
  });

  it('keeps non-personal allowlisted values and reports nothing withheld', () => {
    expect(consentProofFor({ consent_text: 'Newsletter signup', form_id: 'frm_1' }, false)).toEqual({
      proof: { consent_text: 'Newsletter signup', form_id: 'frm_1' },
      proofWithheld: false,
    });
  });
});

describe('consentProofFor hides national phones and addresses (#765)', () => {
  it('withholds a national-format phone number in an allowlisted proof key', () => {
    for (const value of ['called back on 555 123 4567', 'called back on (555) 123-4567', 'called back on 020 7946 0958']) {
      expect(consentProofFor({ via: value, system: 'Kit' }, false), value).toEqual({
        proof: { system: 'Kit' },
        proofWithheld: true,
      });
    }
  });

  it('withholds a Danish 8-digit number in an allowlisted proof key (0.14.11 review)', () => {
    expect(consentProofFor({ via: '12345678', system: 'Kit' }, false)).toEqual({ proof: { system: 'Kit' }, proofWithheld: true });
    expect(consentProofFor({ via: '12 34 56 78', system: 'Kit' }, false)).toEqual({ proof: { system: 'Kit' }, proofWithheld: true });
  });

  it('withholds a postal address in an allowlisted proof key', () => {
    expect(consentProofFor({ method: 'signed at 123 Main Street', issue: 'Hauptstraße 12' }, false)).toEqual({
      proof: {},
      proofWithheld: true,
    });
  });

  it('keeps a harmless free-text proof and an ISO date', () => {
    const proof = { via: 'phone call', issue: 'asked for a call back', submitted_at: '2026-11-12', consent_text: 'Newsletter' };
    expect(consentProofFor(proof, false)).toEqual({ proof, proofWithheld: false });
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
