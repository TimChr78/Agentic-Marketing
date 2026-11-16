import type { Purposes } from '@agentic-marketing/artifacts';
import type { ConsentStatus } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import {
  type ConsentInput,
  type ConsentRow,
  consentProofFor,
  currentConsent,
  newConsentEvidence,
  purposeAllowed,
  refusedPurposes,
} from '../src/consent';
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

// #936: every distinct action is evidence, deduplicated only by event identity (the ledger's
// message-id index) or an exact duplicate (same scope, status, source and action time). A
// same-status signup is never folded against an older row: a decisive action can be processed
// after the action it must outrank, so no time window is safe.
describe('newConsentEvidence (#936)', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 12, minute));
  const consent = (minute: number, status: ConsentStatus = 'granted', extra: Partial<ConsentInput> = {}): ConsentInput => ({
    purpose: P,
    status,
    source: 'form',
    recordedAt: at(minute),
    ...extra,
  });
  const stored = (minute: number, status: ConsentStatus = 'granted', source: ConsentInput['source'] = 'form', channel = '') => ({
    purpose: P,
    channel,
    status,
    source,
    recordedAt: at(minute),
  });

  it('keeps a newer same-status signup as evidence (the out-of-order case)', () => {
    expect(newConsentEvidence([consent(120)], [stored(0)]).map((r) => r.recordedAt)).toEqual([at(120)]);
  });

  it('keeps an older distinct signup too: an action is not folded by time', () => {
    expect(newConsentEvidence([consent(10)], [stored(20)])).toHaveLength(1);
  });

  it('folds an exact duplicate: same scope, status, source and action time', () => {
    expect(newConsentEvidence([consent(20)], [stored(20)])).toEqual([]);
  });

  it('keeps a second signup minutes later as a distinct action', () => {
    expect(newConsentEvidence([consent(30)], [stored(20)])).toHaveLength(1);
  });

  it('does not fold a different source or channel at the same action time', () => {
    expect(newConsentEvidence([consent(20, 'granted', { source: 'import' })], [stored(20)])).toHaveLength(1);
    expect(newConsentEvidence([consent(20, 'granted', { channel: 'email' })], [stored(20)])).toHaveLength(1);
  });

  it('keeps every distinct action in one batch and folds its exact repeat', () => {
    const kept = newConsentEvidence([consent(120), consent(120), consent(130)], [stored(0)]);
    expect(kept.map((r) => r.recordedAt)).toEqual([at(120), at(130)]);
  });
});
