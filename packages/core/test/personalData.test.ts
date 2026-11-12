import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { personalDataInText, redactText } from '../src/personalData';

// The shared personal-data detectors (#765). Consent proof withholds any allowlisted free-text
// value a detector matches, so a miss here is a leak to a role without profiles:pii.

describe('phone numbers (#765)', () => {
  it('detects national formats written with separators', () => {
    for (const phone of [
      '555 123 4567',
      '(555) 123-4567',
      '020 7946 0958',
      '555.123.4567',
      '555-123-4567',
      '070-123 45 67',
      '+1 (555) 123-4567',
    ])
      expect(personalDataInText(`called back on ${phone}`).length, phone).toBeGreaterThan(0);
  });

  it('still detects international formats', () => {
    expect(personalDataInText('call +44 20 7946 0958')).toContain('[phone]');
    expect(personalDataInText('call 0045 1234 5678')).toContain('[phone]');
    expect(personalDataInText('call +452079460958')).toContain('[phone]');
  });

  it('leaves ISO dates, plain counts and ids with letters alone', () => {
    expect(personalDataInText('2026-11-12')).toEqual([]);
    expect(personalDataInText('at 2026-11-12T09:30:00Z')).toEqual([]);
    expect(personalDataInText('Order 12345 for 899 DKK')).toEqual([]);
    expect(personalDataInText('the answer is 123456789')).toEqual([]);
    expect(personalDataInText('order ORD-123456789 shipped')).toEqual([]);
    expect(personalDataInText('CPR 010190-1234')).toEqual(['[national-id]']);
  });

  it('redacts a national number in free text', () => {
    expect(redactText('Call (555) 123-4567 now')).toBe('Call [phone] now');
  });
});

describe('Danish and Norwegian 8-digit numbers (0.14.11 review)', () => {
  it('detects 8-digit numbers, spaced or contiguous', () => {
    for (const phone of ['12345678', '12 34 56 78', '1234 5678', '+45 12345678', '0045 12 34 56 78'])
      expect(personalDataInText(`call ${phone}`), phone).toContain('[phone]');
  });

  it('keeps date-shaped 8-digit runs and attached ids out', () => {
    expect(personalDataInText('batch 20261112')).not.toContain('[phone]');
    expect(personalDataInText('ref ORD-12345678')).not.toContain('[phone]');
  });
});

describe('postal addresses (#765)', () => {
  it('detects a street address with the number first', () => {
    for (const address of ['123 Main Street', '221B Baker St.', '10 Downing Street', '27 Rue de la Paix']) {
      expect(personalDataInText(`lives at ${address}`), address).toContain('[address]');
      expect(redactText(`lives at ${address}`)).not.toContain(address);
    }
  });

  it('detects a street address with the number last', () => {
    for (const address of ['Hauptstraße 12', 'Nørregade 5', 'Vesterbrogade 12', 'Via Roma 10', 'Calle Mayor 5']) {
      expect(personalDataInText(address), address).toContain('[address]');
    }
  });

  it('detects postcodes for the common markets', () => {
    for (const postcode of [
      '2800 København',
      '75001 Paris',
      '10115 Berlin',
      'SE-111 22 Stockholm',
      'SW1A 1AA',
      'Austin, TX 78701',
      '78701-1234',
    ])
      expect(personalDataInText(postcode), postcode).toContain('[address]');
  });

  it('leaves plain text and counts alone', () => {
    expect(personalDataInText('Order 12345 for 899 DKK')).toEqual([]);
    expect(personalDataInText('Ship 1200 units to the warehouse')).toEqual([]);
    expect(personalDataInText('Newsletter signup')).toEqual([]);
  });
});

describe('detector cost', () => {
  it('stays linear in the length of the text', () => {
    expectLinear(
      (n) => 'Ada, 123 Main Street. Call (555) 123-4567 or write ada@example.com. Lorem ipsum. '.repeat(n),
      (text) => personalDataInText(text),
      500,
    );
    expectLinear(
      (n) => 'Ada, 123 Main Street. Call (555) 123-4567 or write ada@example.com. Lorem ipsum. '.repeat(n),
      (text) => redactText(text),
      500,
    );
  });
});
