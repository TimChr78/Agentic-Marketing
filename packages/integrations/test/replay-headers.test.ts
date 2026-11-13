import { describe, expect, it } from 'vitest';
import { replayHeaderValues } from '../src/inbound';

// The replay identity of a generic delivery includes the headers its mapping reads (0.14.11 review).
const headers = { 'x-event-id': 'e1', 'x-device': 'd1', 'user-agent': 'ua', host: 'h', 'x-other': 'o' };

describe('replayHeaderValues', () => {
  it('takes only the headers a mapping names, in any JSONata form', () => {
    expect(replayHeaderValues({ mapping: '{"messageId": headers."x-event-id"}' }, headers)).toBe('x-event-id:e1');
    expect(replayHeaderValues({ mapping: '{"a": headers.`x-device`, "b": headers."X-Event-Id"}' }, headers)).toBe(
      'x-device:d1\nx-event-id:e1',
    );
  });

  it('takes every header except the per-attempt ones when the mapping uses the headers object wholesale', () => {
    // A wholesale mapping can select any header, so the client-identity headers count too
    // (0.14.11 round 4); only the headers that change per delivery attempt are left out.
    expect(replayHeaderValues({ mapping: '$merge([body, {"h": headers}])' }, headers)).toBe(
      'user-agent:ua\nx-device:d1\nx-event-id:e1\nx-other:o',
    );
  });

  it('is empty for a body-only mapping or a connector without a mapping expression', () => {
    expect(replayHeaderValues({ mapping: 'body' }, headers)).toBe('');
    expect(replayHeaderValues({}, headers)).toBe('');
  });

  it('keeps only a named header when the mapping reads it by name, even through $lookup (0.14.11 round 3)', () => {
    const h = { ...headers, 'x-forwarded-for': '192.0.2.1' };
    expect(replayHeaderValues({ mapping: '{"anonymousId": $lookup(headers, "x-forwarded-for")}' }, h)).toContain(
      'x-forwarded-for:192.0.2.1',
    );
    expect(replayHeaderValues({ mapping: '{"ip": headers."x-forwarded-for"}' }, h)).toBe('x-forwarded-for:192.0.2.1');
  });

  it('includes a client-identity header under a wholesale mapping (0.14.11 round 4)', () => {
    const h = { ...headers, 'x-forwarded-for': '192.0.2.1' };
    expect(replayHeaderValues({ mapping: '$lookup(headers, "x-forwarded-" & "for")' }, h)).toContain('x-forwarded-for:192.0.2.1');
  });

  it('excludes a per-attempt header under a wholesale mapping (0.14.11 round 4)', () => {
    const h = { ...headers, traceparent: '00-abc-def-01', 'cf-ray': '8f00-AMS', 'x-request-id': 'r1', date: 'Thu, 12 Nov 2026' };
    const values = replayHeaderValues({ mapping: '$merge([body, {"h": headers}])' }, h);
    expect(values).toBe('user-agent:ua\nx-device:d1\nx-event-id:e1\nx-other:o');
    expect(values).not.toContain('traceparent');
    expect(values).not.toContain('cf-ray');
    expect(values).not.toContain('x-request-id');
    expect(values).not.toContain('date');
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
