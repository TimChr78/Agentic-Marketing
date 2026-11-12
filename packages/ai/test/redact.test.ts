import { describe, expect, it } from 'vitest';
import { redact } from '../src/context';

// #641: `redact` used to stop at depth 5 and return the whole subtree unchanged, so contact and
// payment details nested a few levels into event properties or traits reached the model and the
// `ai_calls` log in clear. It now walks iteratively with no depth cap, and any structural cap
// (cycles, size) fails closed with a marker instead of passing the value through.

const EMAIL = 'ada@example.com';
const PHONE = '+45 12 34 56 78';
const CARD = '4111 1111 1111 1111';

/** An object holding the leaves, wrapped `depth` times. The old cap skipped the object at depth 6. */
function atDepth(depth: number, value: unknown): unknown {
  let out = value;
  for (let i = 0; i < depth; i++) out = { nested: out };
  return out;
}

describe('redact', () => {
  it('redacts e-mail, phone and card numbers nested at depth 6, 10 and 50', () => {
    for (const depth of [6, 10, 50]) {
      const json = JSON.stringify(redact(atDepth(depth, { email: EMAIL, phone: PHONE, card: CARD })));
      expect(json, `depth ${depth}`).not.toContain(EMAIL);
      expect(json, `depth ${depth}`).not.toContain('4111');
      expect(json, `depth ${depth}`).not.toContain('12 34 56 78');
      expect(json, `depth ${depth}`).toContain('[email]');
      expect(json, `depth ${depth}`).toContain('[phone]');
      expect(json, `depth ${depth}`).toContain('[card]');
    }
  });

  it('walks arrays the same way, however deep they are', () => {
    const value = atDepth(6, [{ email: EMAIL }, [{ phone: PHONE }]]);
    const json = JSON.stringify(redact(value));
    expect(json).not.toContain(EMAIL);
    expect(json).not.toContain('12 34 56 78');
    expect(json).toContain('[email]');
    expect(json).toContain('[phone]');
  });

  it('handles a very deep value without overflowing the stack and still redacts the leaf', () => {
    const depth = 5_000;
    const input = atDepth(depth, { email: EMAIL });
    const out = redact(input);
    let node = out as Record<string, unknown>;
    for (let i = 0; i < depth; i++) node = node.nested as Record<string, unknown>;
    expect(node).toEqual({ email: '[email]' });
  });

  it('fails closed on a self-referencing value instead of leaking or throwing', () => {
    const person: Record<string, unknown> = { email: EMAIL };
    person.self = person;
    const out = redact(person);
    expect(() => JSON.stringify(out)).not.toThrow();
    const json = JSON.stringify(out);
    expect(json).not.toContain(EMAIL);
    expect(json).toContain('[email]');
    expect(json).toMatch(/redacted/);
  });

  it('replaces the uncapped remainder of a huge input with a marker', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) wide[`field${i}`] = 'plain';
    wide.field19_999 = EMAIL;
    let out: Record<string, unknown> = {};
    expect(() => {
      out = redact(wide) as Record<string, unknown>;
    }).not.toThrow();
    const json = JSON.stringify(out);
    expect(json).not.toContain(EMAIL);
    expect(json).toMatch(/redacted/);
    expect(Object.values(out)).toContain('[redacted: too large]');
  });

  it('never passes the truncated tail of a long array', () => {
    const items = Array.from({ length: 200 }, (_, i) => (i === 150 ? EMAIL : 'plain'));
    const json = JSON.stringify(redact(items));
    expect(json).not.toContain(EMAIL);
    expect(json).toContain('[redacted: too large]');
  });
});

describe('8-digit operational values in the AI context (0.14.11 review)', () => {
  it('keeps an 8-digit order number in trigger properties and recent events', () => {
    const out = redact({ trigger: { properties: { order_id: '12345678' } }, recentEvents: [{ properties: { order: '87654321' } }] });
    expect(out.trigger.properties.order_id).toBe('12345678');
    expect(out.recentEvents[0]!.properties.order).toBe('87654321');
  });
});
