import { describe, expect, it } from 'vitest';
import {
  ERROR_DETAILS_MAX_CHARS,
  ERROR_DETAILS_MAX_DEPTH,
  ERROR_DETAILS_MAX_ELEMENTS,
  ERROR_DETAILS_TRUNCATED,
  redactErrorDetails,
} from '../src/diagnostics';

// #996: an AppError's message is redacted before it leaves the executor, but its `details` used to
// travel raw — through REST/MCP error bodies and the copilot's toolResult. One recursive helper
// redacts every string in them, keeps the structure machine-readable and never mutates the error.

const SECRET = 'review_dummy_secret';

describe('redactErrorDetails', () => {
  it('redacts string values in nested objects and arrays, keeping keys and structure', () => {
    const details = {
      reason: 'idempotency_key_reversed',
      problems: [`Unknown parameter: password=${SECRET}`, 'delay: Invalid input'],
      nested: { list: [{ note: `api_key=${SECRET}` }, { ok: true, count: 2, missing: null }] },
    };

    const out = redactErrorDetails(details) as typeof details;

    expect(JSON.stringify(out)).not.toContain(SECRET);
    // Structured fields stay machine-readable: only the string contents changed.
    expect(out.reason).toBe('idempotency_key_reversed');
    expect(out.problems).toHaveLength(2);
    expect(out.problems[0]).toContain('Unknown parameter: password=');
    expect(out.problems[1]).toBe('delay: Invalid input');
    expect(out.nested.list[0]!.note).toContain('api_key=');
    expect(out.nested.list[1]).toEqual({ ok: true, count: 2, missing: null });
    // Redacting a string is not truncation: no marker where nothing was cut.
    expect(Object.keys(out)).not.toContain(ERROR_DETAILS_TRUNCATED);
    expect(Object.keys(out.nested)).not.toContain(ERROR_DETAILS_TRUNCATED);
  });

  it('keeps the error code-like values a client switches on', () => {
    const details = { reason: 'idempotency_key_reused', other: 'idempotency_in_progress' };
    const out = redactErrorDetails(details) as typeof details;
    expect(out.reason).toBe('idempotency_key_reused');
    expect(out.other).toBe('idempotency_in_progress');
  });

  it('bounds a long string, redacting it while it is still complete', () => {
    const long = `${'word '.repeat(ERROR_DETAILS_MAX_CHARS / 4)}password=${SECRET}`;
    const out = redactErrorDetails(long) as string;
    expect(out).toHaveLength(ERROR_DETAILS_MAX_CHARS);
    expect(out).not.toContain(SECRET);
  });

  it('replaces values past the depth limit with a marker', () => {
    let deep: Record<string, unknown> = { leaf: `password=${SECRET}` };
    for (let i = 0; i < ERROR_DETAILS_MAX_DEPTH + 3; i += 1) deep = { next: deep };

    const out = redactErrorDetails(deep);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).toContain(ERROR_DETAILS_TRUNCATED);
  });

  it('truncates past the element limit with a marker', () => {
    const array = redactErrorDetails(Array.from({ length: ERROR_DETAILS_MAX_ELEMENTS + 50 }, (_, i) => `item ${i}`)) as string[];
    expect(array).toHaveLength(ERROR_DETAILS_MAX_ELEMENTS + 1);
    expect(array.at(-1)).toBe(ERROR_DETAILS_TRUNCATED);

    const entries: Record<string, string> = {};
    for (let i = 0; i < ERROR_DETAILS_MAX_ELEMENTS + 50; i += 1) entries[`key${i}`] = `value ${i}`;
    const object = redactErrorDetails(entries) as Record<string, string>;
    expect(Object.keys(object)).toHaveLength(ERROR_DETAILS_MAX_ELEMENTS + 1);
    expect(object[ERROR_DETAILS_TRUNCATED]).toBe(ERROR_DETAILS_TRUNCATED);
  });

  it('never mutates the error details it is given', () => {
    const details = { problems: [`password=${SECRET}`], nested: { keep: ['a', `token=${SECRET}`] } };
    const before = structuredClone(details);

    const out = redactErrorDetails(details);

    expect(details).toEqual(before);
    expect(out).not.toBe(details);
    expect((out as typeof details).nested).not.toBe(details.nested);
  });

  it('keeps an input with nothing to redact unchanged and returns the same reference', () => {
    const clean = { reason: 'idempotency_key_reused', problems: ['delay: Invalid input'], retryable: true };
    expect(redactErrorDetails(clean)).toBe(clean);
  });

  it('is idempotent, including at the depth and size limits', () => {
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let i = 0; i < ERROR_DETAILS_MAX_DEPTH; i += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    cursor.leaf = `password=${SECRET}`;
    const input = {
      problems: [`password=${SECRET}`, 'x'.repeat(ERROR_DETAILS_MAX_CHARS + 10)],
      deep: nested,
      many: Array.from({ length: ERROR_DETAILS_MAX_ELEMENTS + 5 }, () => `password=${SECRET}`),
    };

    const once = redactErrorDetails(input);
    const twice = redactErrorDetails(once);

    expect(twice).toEqual(once);
  });

  it('keeps non-string primitives and null as they are', () => {
    const out = redactErrorDetails({ retryable: true, count: 3, ratio: 0.5, missing: null });
    expect(out).toEqual({ retryable: true, count: 3, ratio: 0.5, missing: null });
  });
});
