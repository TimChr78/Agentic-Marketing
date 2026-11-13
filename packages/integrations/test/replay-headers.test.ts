import { describe, expect, it } from 'vitest';
import { replayHeaderValues } from '../src/inbound';

// The replay identity of a generic delivery includes the headers its mapping reads (0.14.11 review).
const headers = { 'x-event-id': 'e1', 'x-device': 'd1', 'user-agent': 'ua', host: 'h', 'x-other': 'o' };
const all = 'host:h\nuser-agent:ua\nx-device:d1\nx-event-id:e1\nx-other:o';

describe('replayHeaderValues', () => {
  it('takes only the headers a mapping names, in any JSONata form', () => {
    expect(replayHeaderValues({ mapping: '{"messageId": headers."x-event-id"}' }, headers)).toBe('x-event-id:e1');
    expect(replayHeaderValues({ mapping: '{"a": headers.`x-device`, "b": headers."X-Event-Id"}' }, headers)).toBe(
      'x-device:d1\nx-event-id:e1',
    );
  });

  it('takes only a bare field reference (headers.x)', () => {
    expect(replayHeaderValues({ mapping: '{"id": headers.x}' }, { ...headers, x: 'only' })).toBe('x:only');
  });

  it('takes every header when the mapping uses the headers object wholesale (0.14.11 round 5)', () => {
    // A wholesale mapping can select any header, so every header counts, including the ones that
    // change per delivery attempt: the mapping's output may depend on them.
    expect(replayHeaderValues({ mapping: '$merge([body, {"h": headers}])' }, headers)).toBe(all);
  });

  it('takes every header when the mapping enumerates their names (0.14.11 round 5)', () => {
    expect(replayHeaderValues({ mapping: '{"keys": $keys(headers)}' }, headers)).toBe(all);
  });

  it('is empty for a body-only mapping or a connector without a mapping expression', () => {
    expect(replayHeaderValues({ mapping: 'body' }, headers)).toBe('');
    expect(replayHeaderValues({}, headers)).toBe('');
  });

  it('keeps only a named header when the mapping reads it by name, even through $lookup (0.14.11 round 3)', () => {
    const h = { ...headers, 'x-forwarded-for': '192.0.2.1' };
    expect(replayHeaderValues({ mapping: '{"anonymousId": $lookup(headers, "x-forwarded-for")}' }, h)).toBe('x-forwarded-for:192.0.2.1');
    expect(replayHeaderValues({ mapping: '{"anonymousId": $lookup(headers, \'x-forwarded-for\')}' }, h)).toBe('x-forwarded-for:192.0.2.1');
    expect(replayHeaderValues({ mapping: '{"ip": headers."x-forwarded-for"}' }, h)).toBe('x-forwarded-for:192.0.2.1');
  });

  it('takes every header when a $lookup name is computed (0.14.11 round 5)', () => {
    // The reviewer's reproducer: `$lookup(headers, "x-request-" & "id")` can read any header, so
    // the per-attempt x-request-id must be part of the identity.
    const h = { ...headers, 'x-request-id': 'person-a', date: 'Thu, 12 Nov 2026', traceparent: '00-abc-def-01' };
    const values = replayHeaderValues({ mapping: '$merge([body, {"anonymousId": $lookup(headers, "x-request-" & "id")}])' }, h);
    expect(values).toContain('x-request-id:person-a');
    expect(values).toContain('date:Thu, 12 Nov 2026');
    expect(values).toContain('traceparent:00-abc-def-01');
    expect(values).toBe(
      'date:Thu, 12 Nov 2026\nhost:h\ntraceparent:00-abc-def-01\nuser-agent:ua\nx-device:d1\nx-event-id:e1\nx-other:o\nx-request-id:person-a',
    );
  });

  it('takes every header for an unrecognised use of the headers object (0.14.11 round 5)', () => {
    const h = { ...headers, 'x-request-id': 'r1' };
    expect(replayHeaderValues({ mapping: '{"id": headers["x-request-id"]}' }, h)).toBe(
      'host:h\nuser-agent:ua\nx-device:d1\nx-event-id:e1\nx-other:o\nx-request-id:r1',
    );
    expect(replayHeaderValues({ mapping: '{"id": $each(headers, function($v, $k) {$k})}' }, h)).toContain('x-request-id:r1');
  });

  it('still joins a per-attempt header the mapping names as a string literal (0.14.11 round 3)', () => {
    const h = { ...headers, traceparent: '00-abc-def-01' };
    expect(replayHeaderValues({ mapping: '$lookup(headers, "traceparent")' }, h)).toContain('traceparent:00-abc-def-01');
  });

  it("adds the connector's own identity headers, such as the Shopify topic (0.14.11 round 3)", () => {
    const h = { 'x-shopify-topic': 'orders/paid', 'x-shopify-webhook-id': 'w1' };
    expect(replayHeaderValues({}, h, ['x-shopify-topic'])).toBe('x-shopify-topic:orders/paid');
  });
});
