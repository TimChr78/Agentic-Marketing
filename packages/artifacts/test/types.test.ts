import { describe, expect, it } from 'vitest';
import { listTypes } from '../src/commands';
import { ARTIFACT_TYPES } from '../src/types';

const ctx = {} as never;

describe('artifacts.types', () => {
  it('returns every type without an argument', async () => {
    const out = await listTypes.handler({}, ctx);
    expect(out.types.map((t) => t.type)).toEqual(ARTIFACT_TYPES);
  });

  it('returns one type when given a type', async () => {
    const out = await listTypes.handler({ type: 'broadcast' }, ctx);
    expect(out.types).toHaveLength(1);
    const broadcast = out.types[0]!;
    expect(broadcast.type).toBe('broadcast');
    expect(broadcast.description).toMatch(/template-per-issue/);
    const schema = broadcast.contentSchema as { properties: Record<string, { description?: string }> };
    expect(schema.properties.template!.description).toMatch(/published/);
  });

  it('accepts an empty object', () => {
    expect(listTypes.input.parse({})).toEqual({});
  });

  it('rejects an unknown type and lists the valid names', () => {
    const parsed = listTypes.input.safeParse({ type: 'newsletter' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues[0]?.message ?? '';
    expect(message).toContain('Unknown artifact type');
    for (const type of ARTIFACT_TYPES) expect(message).toContain(type);
  });
});
