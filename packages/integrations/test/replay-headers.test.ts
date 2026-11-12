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
});
