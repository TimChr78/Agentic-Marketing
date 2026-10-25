import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findUnknownInputKeys, unknownKeyMessages } from '../src';

describe('findUnknownInputKeys', () => {
  it('finds unknown top-level and nested keys and lists the keys allowed there', () => {
    const schema = z.object({ artifactId: z.string(), note: z.string(), content: z.object({ title: z.string(), body: z.string() }) });
    expect(findUnknownInputKeys(schema, { artifactId: 'a', note: 'n', bypassReview: true })).toEqual([
      { path: 'bypassReview', allowed: ['artifactId', 'note', 'content'] },
    ]);
    expect(findUnknownInputKeys(schema, { artifactId: 'a', note: 'n', content: { title: 't', body: 'b', foo: 1 } })).toEqual([
      { path: 'content.foo', allowed: ['title', 'body'] },
    ]);
  });

  it('walks arrays and optional, default and nullable wrappers', () => {
    const schema = z.object({
      rows: z.array(z.object({ email: z.string() })).optional(),
      when: z.string().default('now').nullable(),
      limit: z.number().optional(),
    });
    expect(findUnknownInputKeys(schema, { rows: [{ email: 'a', extra: 1 }], when: 'x', limit: 2, nope: 3 })).toEqual([
      { path: 'rows.0.extra', allowed: ['email'] },
      { path: 'nope', allowed: ['rows', 'when', 'limit'] },
    ]);
  });

  it('accepts a key allowed by any union branch, but not one no branch allows', () => {
    const schema = z.union([z.object({ email: z.string() }), z.object({ userId: z.string() })]);
    expect(findUnknownInputKeys(schema, { email: 'a' })).toEqual([]);
    expect(findUnknownInputKeys(schema, { email: 'a', userId: 'u', other: 1 })).toEqual([{ path: 'other', allowed: ['email', 'userId'] }]);
  });

  it('uses the selected discriminated-union branch', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('email'), subject: z.string() }),
      z.object({ kind: z.literal('sms'), body: z.string() }),
    ]);
    // The `sms` field is unknown in the selected `email` branch, while `subject` is allowed there.
    expect(findUnknownInputKeys(schema, { kind: 'email', subject: 'Hi', body: 'text' })).toEqual([
      { path: 'body', allowed: ['kind', 'subject'] },
    ]);
  });

  it('accepts any key in records, unknown and catchall objects, and merges intersections', () => {
    expect(findUnknownInputKeys(z.record(z.string(), z.string()), { anything: 'ok' })).toEqual([]);
    expect(findUnknownInputKeys(z.object({ data: z.unknown() }), { data: { anything: true } })).toEqual([]);
    expect(findUnknownInputKeys(z.object({ a: z.string() }).catchall(z.string()), { a: 'x', b: 'y' })).toEqual([]);
    const both = z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }));
    expect(findUnknownInputKeys(both, { a: 'x', b: 'y' })).toEqual([]);
    expect(findUnknownInputKeys(z.object({ a: z.string() }).strict(), { a: 'x', b: 'y' })).toEqual([{ path: 'b', allowed: ['a'] }]);
  });

  it('builds actionable messages', () => {
    expect(unknownKeyMessages('artifacts.requestPublish', [{ path: 'bypassReview', allowed: ['artifactId', 'note'] }])).toEqual([
      'Unknown input key "bypassReview" for artifacts.requestPublish. Allowed keys: artifactId, note.',
    ]);
  });
});
