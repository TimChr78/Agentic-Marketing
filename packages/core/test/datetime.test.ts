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

  it('stays a described string in the input JSON schema', () => {
    const schema = z.object({ sendAt: isoDateTime('sendAt').optional() });
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as unknown as {
      properties: { sendAt: { type: string; description: string } };
    };
    expect(json.properties.sendAt.type).toBe('string');
    expect(json.properties.sendAt.description).toContain('ISO 8601 with a time zone');
  });
});
