import { describe, expect, it } from 'vitest';
import { mappedReplayHeaders } from '../src/inbound';

// The replay identity of a generic delivery is the body plus the values of the headers its mapping
// actually read while it ran (0.14.11 review round 7): any header read, by any JSONata construct,
// is part of it; headers the mapping never touched are not.
const headers = { 'x-event-id': 'e1', 'x-device': 'd1', 'user-agent': 'ua', host: 'h', 'x-other': 'o' };
const all = 'host:h\nuser-agent:ua\nx-device:d1\nx-event-id:e1\nx-other:o';

describe('mappedReplayHeaders', () => {
  it('takes exactly the headers a mapping reads by name, in any JSONata form', async () => {
    expect(await mappedReplayHeaders('{"messageId": headers."x-event-id"}', {}, headers)).toBe('x-event-id:e1');
    expect(await mappedReplayHeaders('{"a": headers.`x-device`, "b": $lookup(headers, "x-event-id")}', {}, headers)).toBe(
      'x-device:d1\nx-event-id:e1',
    );
    expect(await mappedReplayHeaders('{"id": $lookup(headers, "x-even" & "t-id")}', {}, headers)).toBe('x-event-id:e1');
  });

  it('takes every header when the mapping enumerates or copies the headers object', async () => {
    expect(await mappedReplayHeaders('$merge([body, {"h": headers}])', {}, headers)).toBe(all);
    expect(await mappedReplayHeaders('{"keys": $keys(headers)}', {}, headers)).toBe(all);
  });

  it('is empty for a body-only mapping', async () => {
    expect(await mappedReplayHeaders('body', { a: 1 }, headers)).toBe('');
  });

  it('follows only the branch the mapping took for this body', async () => {
    const mapping = 'body.useDevice ? {"id": headers."x-device"} : {"id": headers."x-event-id"}';
    expect(await mappedReplayHeaders(mapping, { useDevice: true }, headers)).toBe('x-device:d1');
    expect(await mappedReplayHeaders(mapping, { useDevice: false }, headers)).toBe('x-event-id:e1');
  });

  it('records a header the mapping reads when only one delivery has it', async () => {
    const mapping = '{"id": headers.x}';
    expect(await mappedReplayHeaders(mapping, {}, { other: 'o' })).toBe('');
    expect(await mappedReplayHeaders(mapping, {}, { other: 'o', x: 'p' })).toBe('x:p');
  });

  it('catches every construct the round-6 and round-7 reviews used to read a header unseen', async () => {
    const h = { x: 'person-a', other: 'o' };
    const body = { type: 'track', event: 'Review', userId: 'u', expr: 'headers.x' };
    const exprs = [
      '/* " */ headers.x /* " */',
      'headers."\\u0078"',
      '$lookup(headers, "\\u0078")',
      '$.headers.x',
      '"headers".x',
      '($h := $; $h.headers.x)',
      '($f := function(){$$.headers.x}; $f())',
      '$eval(body.expr)',
      '($e := $eval; $e(body.expr))',
      '*.x',
      '**.x',
      'body.%.(*.x)',
      'body.%.(**.x)',
      '($t := | * | {"seen": x} |; $string($t(*)))',
      '$string()',
      '$spread()',
      '$spread().*.x',
      '$each(function($v){$v})',
      '$lookup($spread()[1], $keys()[1]).x',
      '$match($string(), /person-[ab]/).match',
      'headers.other{"v": $$.headers.x}',
      '$lookup(headers, "other")[$$.headers.x = "person-a"]',
    ];
    for (const expr of exprs) {
      const identity = await mappedReplayHeaders(`$merge([body, {"anonymousId": $string((${expr}))}])`, body, h);
      expect(identity, expr).toContain('x:person-a');
    }
  });
});
