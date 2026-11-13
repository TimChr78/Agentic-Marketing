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

  it('takes every non-transport header when the mapping uses the headers object wholesale', () => {
    expect(replayHeaderValues({ mapping: '$merge([body, {"h": headers}])' }, headers)).toBe('x-device:d1\nx-event-id:e1\nx-other:o');
  });

  it('is empty for a body-only mapping or a connector without a mapping expression', () => {
    expect(replayHeaderValues({ mapping: 'body' }, headers)).toBe('');
    expect(replayHeaderValues({}, headers)).toBe('');
  });

  it('keeps a transport header the mapping reads by name, even through $lookup (0.14.11 round 3)', () => {
    const h = { ...headers, 'x-forwarded-for': '192.0.2.1' };
    expect(replayHeaderValues({ mapping: '{"anonymousId": $lookup(headers, "x-forwarded-for")}' }, h)).toContain(
      'x-forwarded-for:192.0.2.1',
    );
    expect(replayHeaderValues({ mapping: '{"ip": headers."x-forwarded-for"}' }, h)).toBe('x-forwarded-for:192.0.2.1');
    // A wholesale mapping that names no transport header still ignores per-hop headers.
    expect(replayHeaderValues({ mapping: '$merge([body, {"h": headers}])' }, h)).not.toContain('x-forwarded-for');
  });

  it("adds the connector's own identity headers, such as the Shopify topic (0.14.11 round 3)", () => {
    const h = { 'x-shopify-topic': 'orders/paid', 'x-shopify-webhook-id': 'w1' };
    expect(replayHeaderValues({}, h, ['x-shopify-topic'])).toBe('x-shopify-topic:orders/paid');
  });
});
