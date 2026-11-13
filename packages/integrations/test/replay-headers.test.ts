import { describe, expect, it } from 'vitest';
import { mappedReplayHeaders } from '../src/inbound';

// The replay identity of a delivery (0.14.11 review round 9): every request header, except the
// per-attempt ones (date, request and trace ids, client-IP hops, user-agent, Standard Webhooks
// timestamp and signature) that the mapping did not read in its real run. No header that changed
// a real output can be missing from that delivery's identity, so no distinct event is ever folded
// into another; an ordinary retry differs only in per-attempt headers and still dedupes.
const id = (mapping: string, body: unknown, headers: Record<string, string>) => mappedReplayHeaders(mapping, body, headers);

describe('mappedReplayHeaders', () => {
  it('includes every stable header and leaves out unread per-attempt ones', async () => {
    const h = { 'x-shop': 's1', 'x-request-id': 'r1', date: 'd1', traceparent: 't1', 'user-agent': 'ua' };
    expect(await id('body', {}, h)).toBe('x-shop:s1');
  });

  it('includes a per-attempt header the mapping read, however it reached it', async () => {
    const h = { 'x-shop': 's1', 'x-request-id': 'r1', traceparent: 't1' };
    expect(await id('{"id": $lookup(headers, "x-request-" & "id")}', {}, h)).toBe('x-request-id:r1\nx-shop:s1');
    expect(await id('$string()', {}, h)).toBe('traceparent:t1\nx-request-id:r1\nx-shop:s1');
    expect(await id('**.traceparent', {}, h)).toBe('traceparent:t1\nx-request-id:r1\nx-shop:s1');
  });

  it('dedupes a retry that changes only unread per-attempt headers', async () => {
    const mapping = '$merge([body, {"anonymousId": headers."x-device"}])';
    const a = await id(mapping, {}, { 'x-device': 'd', date: 'Mon', 'x-request-id': 'r1', 'cf-ray': 'a' });
    const b = await id(mapping, {}, { 'x-device': 'd', date: 'Tue', 'x-request-id': 'r2', 'cf-ray': 'b' });
    expect(a).toBe(b);
  });

  it('never folds two deliveries whose real outputs differ (rounds 6 to 9)', async () => {
    const body = { type: 'track', event: 'Review', userId: 'u', expr: 'headers.x', cutoff: Date.now() + 60_000 };
    const exprs = [
      'headers.x',
      '/* " */ headers.x /* " */',
      '$lookup(headers, "\\u0078")',
      '$.headers.x',
      '"headers".x',
      '($h := $; $h.headers.x)',
      '$eval(body.expr)',
      '($e := $eval; $e(body.expr))',
      '*.x',
      '**.x',
      '$string()',
      '$spread().*.x',
      'headers.other{"v": $$.headers.x}',
      '$millis() > 0 ? headers.x : "person-a"',
      '$eval("$millis()") > 0 ? headers.x : "person-a"',
      '$millis() < body.cutoff ? headers.x : "person-a"',
      '$shuffle([true, false])[0] ? headers.x : "person-a"',
    ];
    for (const expr of exprs) {
      const mapping = `$merge([body, {"anonymousId": $string((${expr}))}])`;
      const a = await id(mapping, body, { x: 'person-a', other: 'o' });
      const b = await id(mapping, body, { x: 'person-b', other: 'o' });
      expect(a, expr).not.toBe(b);
    }
  });

  it('gives an identical retry the same identity whatever the clock or random source does', async () => {
    const h = { x: 'person-a', other: 'o' };
    for (const expr of [
      '$millis() < 0 ? headers.x : "c"',
      '$shuffle([true, false])[0] ? headers.x : "c"',
      '$random() < 0.5 ? headers.x : headers.other',
    ]) {
      const runs = new Set(await Promise.all(Array.from({ length: 8 }, () => id(`{"v": ${expr}}`, {}, h))));
      expect(runs.size, expr).toBe(1);
    }
  });
});
