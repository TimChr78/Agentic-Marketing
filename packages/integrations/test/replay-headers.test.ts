import { describe, expect, it } from 'vitest';
import { mappedReplayHeaders } from '../src/inbound';

// The replay identity of a delivery (0.14.11 review round 10): the body plus the values of the
// headers its mapping read in its real run. Two identities match only when both runs read the same
// headers with the same values, so no header-caused difference is ever folded away; a header the
// mapping never reads (an attacker's extra header, a provider's per-attempt signature or
// timestamp) cannot make a replay look new.
const id = (mapping: string, body: unknown, headers: Record<string, string>) => mappedReplayHeaders(mapping, body, headers);

describe('mappedReplayHeaders', () => {
  it('is the headers the mapping read, by any construct', async () => {
    const h = { 'x-shop': 's1', 'x-request-id': 'r1', traceparent: 't1' };
    expect(await id('body', {}, h)).toBe('');
    expect(await id('{"s": headers."x-shop"}', {}, h)).toBe('x-shop:s1');
    expect(await id('{"id": $lookup(headers, "x-request-" & "id")}', {}, h)).toBe('x-request-id:r1');
    expect(await id('$string()', {}, h)).toBe('traceparent:t1\nx-request-id:r1\nx-shop:s1');
    expect(await id('**.traceparent', {}, h)).toBe('traceparent:t1\nx-request-id:r1\nx-shop:s1');
  });

  it('ignores an extra header the mapping never reads, so a signed body cannot be replayed with one (round 10)', async () => {
    expect(await id('body', {}, { 'x-signature': 'sig' })).toBe(await id('body', {}, { 'x-signature': 'sig', 'x-unrelated': '1' }));
  });

  it('dedupes provider retries whose attempt headers change but are not read (round 10)', async () => {
    const mapping = '$merge([body, {"anonymousId": headers."x-device"}])';
    const first = {
      'x-device': 'd',
      'stripe-signature': 't=1,v1=a',
      'svix-timestamp': '1',
      'svix-signature': 'v1,a',
      'x-hubspot-request-timestamp': '1',
      'x-hubspot-signature-v3': 'a',
      'x-zapier-timestamp': '1',
      'x-zapier-signature': 'a',
      'x-forwarded-server': 'edge-1',
      date: 'Mon',
    };
    const retry = {
      ...first,
      'stripe-signature': 't=2,v1=b',
      'svix-timestamp': '2',
      'svix-signature': 'v1,b',
      'x-hubspot-request-timestamp': '2',
      'x-hubspot-signature-v3': 'b',
      'x-zapier-timestamp': '2',
      'x-zapier-signature': 'b',
      'x-forwarded-server': 'edge-2',
      date: 'Tue',
    };
    expect(await id(mapping, {}, first)).toBe(await id(mapping, {}, retry));
  });

  it('never folds two deliveries whose real outputs differ because of a header (rounds 6 to 10)', async () => {
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
    ];
    for (const expr of exprs) {
      const mapping = `$merge([body, {"anonymousId": $string((${expr}))}])`;
      const a = await id(mapping, body, { x: 'person-a', other: 'o' });
      const b = await id(mapping, body, { x: 'person-b', other: 'o' });
      expect(a, expr).not.toBe(b);
    }
  });

  it('documents the accepted residual: header reads that depend on chance can differ between retries', async () => {
    // A mapping whose choice of which header to read depends on the clock or a random source can
    // give an identical retry another identity: it may publish twice, but it never loses an event.
    const runs = new Set(await Promise.all(Array.from({ length: 16 }, () => id('$random() < 0.5 ? headers.x : "c"', {}, { x: 'a' }))));
    expect([...runs].every((r) => r === '' || r === 'x:a')).toBe(true);
  });
});
