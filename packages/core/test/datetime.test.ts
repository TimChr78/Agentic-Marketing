import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isoDateTime } from '../src';

describe('isoDateTime', () => {
  it('accepts Z and numeric offsets and normalises to UTC', () => {
    const field = isoDateTime('sendAt');
    expect(field.parse('2026-10-24T15:00:00+02:00')).toBe('2026-10-24T13:00:00.000Z');
    expect(field.parse('2026-10-24T15:00:00-0500')).toBe('2026-10-24T20:00:00.000Z');
    expect(field.parse('2026-10-24T13:00:00.250Z')).toBe('2026-10-24T13:00:00.250Z');
    expect(field.parse('2026-10-24T13:00Z')).toBe('2026-10-24T13:00:00.000Z');
  });

  it('rejects a date-time without a time zone, naming the field and showing both forms', () => {
    const result = isoDateTime('sendAt').safeParse('2026-10-24T15:00:00');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('sendAt needs a time zone, e.g. 2026-10-30T07:00:00Z or 2026-10-30T09:00:00+02:00.');
  });

  it('rejects impossible calendar fields instead of rolling them over (#807)', () => {
    const field = isoDateTime('sendAt');
    // Date.parse normalises every one of these to a real instant; a schedule must not move a day.
    for (const value of [
      '2026-02-30T12:00:00Z',
      '2026-02-31T12:00:00Z',
      '2026-04-31T12:00:00Z',
      '2026-02-29T12:00:00Z', // 2026 is not a leap year
      '2026-04-31T12:00:00+02:00',
      '2026-10-24T24:00:00Z',
      '2026-10-24T23:60:00Z',
      '2026-10-24T23:59:60Z',
    ]) {
      const result = field.safeParse(value);
      expect(result.success, `${value} must be rejected`).toBe(false);
      expect(result.error?.issues[0]?.message).toBe('sendAt must be a valid date and time, e.g. 2026-10-30T07:00:00Z.');
    }
  });

  it('accepts a lowercase t and z, as the ISO parser already did (#807)', () => {
    const field = isoDateTime('sendAt');
    // The calendar check used to be case-sensitive while the ISO check was not, so a browser
    // serialising with lowercase letters was rejected by the second refinement only.
    expect(field.parse('2026-10-24t13:00:00z')).toBe('2026-10-24T13:00:00.000Z');
  });

  it('accepts a real leap day and the last minute of the day (#807)', () => {
    const field = isoDateTime('sendAt');
    expect(field.parse('2028-02-29T12:00:00Z')).toBe('2028-02-29T12:00:00.000Z');
    expect(field.parse('2026-04-30T23:59:59Z')).toBe('2026-04-30T23:59:59.000Z');
  });

  it('stays a described string in the input JSON schema', () => {
    const schema = z.object({ sendAt: isoDateTime('sendAt').optional() });
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as unknown as {
      properties: { sendAt: { type: string; description: string } };
    };
    expect(json.properties.sendAt.type).toBe('string');
    expect(json.properties.sendAt.description).toContain('ISO 8601 with a time zone');
  });
});
