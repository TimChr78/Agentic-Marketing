import { describe, expect, it } from 'vitest';
import { clickIdsOfEvent } from '../src';

// `context` is client-supplied JSON: ingest validates it only as a record of unknown values, and
// the sink, the subject-key backfill and the ads hook all read click ids from it. A value that is
// not a string must read as "no click id" rather than throw, so one stored event cannot fail an
// unrelated write.

const seenAt = Date.UTC(2026, 10, 2, 12, 0, 0);

describe('clickIdsOfEvent on client-supplied context', () => {
  it('reads click ids from a landing page and from named click ids', () => {
    expect(clickIdsOfEvent({ page: { url: 'https://shop.test/landing?gclid=abc123' } }, seenAt)).toEqual({ gclid: 'abc123' });
    expect(clickIdsOfEvent({ page: { search: '?gclid=abc123&fbclid=wxyz' } }, seenAt)).toEqual({
      gclid: 'abc123',
      fbc: `fb.1.${seenAt}.wxyz`,
    });
    expect(clickIdsOfEvent({ clickIds: { gclid: 'abcd', msclkid: 'efgh' } }, seenAt)).toEqual({ gclid: 'abcd', msclkid: 'efgh' });
  });

  it('reads the legacy page.search shapes a stored row can carry', () => {
    // Earlier releases passed `page.search` to URLSearchParams, so a stored row may hold the parsed
    // parameters itself. The backfill and every other reader of stored rows must still find them.
    expect(clickIdsOfEvent({ page: { search: { gclid: 'abc123' } } }, seenAt)).toEqual({ gclid: 'abc123' });
    expect(clickIdsOfEvent({ page: { search: [['gclid', 'abc123']] } }, seenAt)).toEqual({ gclid: 'abc123' });
    expect(clickIdsOfEvent({ page: { search: ['gclid=abc123'] } }, seenAt)).toEqual({ gclid: 'abc123' });
    // A parameter map of a value the old parser coerced still reads as the ids it names.
    expect(clickIdsOfEvent({ page: { search: { gclid: 123456 } } }, seenAt)).toEqual({ gclid: '123456' });
  });

  it.each([
    ['a number', 5],
    ['a boolean', true],
    ['a string', 'https://shop.test/landing?gclid=abc123'],
    ['an array', ['https://shop.test/landing?gclid=abc123']],
    ['null', null],
    ['an object without a url', { referrer: 'https://shop.test/' }],
    ['a numeric url', { url: 5 }],
    ['a boolean url', { url: true }],
    ['an object url', { url: { href: 'https://shop.test/?gclid=abc123' } }],
    ['an array url', { url: ['https://shop.test/?gclid=abc123'] }],
    ['a numeric search', { url: 'https://shop.test/landing', search: 5 }],
    ['an array of non-pairs', { search: [5] }],
    ['a map of unusable values', { search: { gclid: { href: 'https://shop.test/' } } }],
  ])('returns no click ids for %s in context.page', (_label, page) => {
    expect(clickIdsOfEvent({ page }, seenAt)).toEqual({});
  });

  it.each([
    ['a string', 'gclid=abc123'],
    ['a number', 5],
    ['a boolean', true],
    ['an array', ['gclid=abc123']],
    ['null', null],
  ])('returns no click ids for %s in context.clickIds', (_label, clickIds) => {
    expect(clickIdsOfEvent({ clickIds }, seenAt)).toEqual({});
  });

  it('falls back to the landing page when click ids are not an object of ids', () => {
    // Ingest removes an array-valued clickIds, so the page's own parameters still supply the id.
    expect(clickIdsOfEvent({ clickIds: ['gclid=wxyz789'], page: { url: 'https://shop.test/?gclid=abc123' } }, seenAt)).toEqual({
      gclid: 'abc123',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['a string', 'context'],
    ['an array', []],
  ])('returns no click ids for %s as the whole context', (_label, context) => {
    expect(clickIdsOfEvent(context, seenAt)).toEqual({});
  });
});
