import { describe, expect, it } from 'vitest';
import { isIpOrCidr, normalizeIp, remoteAddressFromEnv, resolveClientIp } from '../src';

const resolve = (
  headers: Record<string, string>,
  remoteAddress?: string,
  trustedProxyCidrs?: string[],
  headerNames = ['cf-connecting-ip', 'x-forwarded-for'],
) =>
  resolveClientIp({
    header: (name) => headers[name.toLowerCase()],
    remoteAddress,
    headerNames,
    trustedProxyCidrs,
  });

describe('resolveClientIp', () => {
  it('uses headers in the configured order (cf-connecting-ip before x-forwarded-for)', () => {
    expect(resolve({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }, '192.0.2.1')).toBe('203.0.113.7');
  });

  it('takes the first address of a comma-separated x-forwarded-for', () => {
    expect(resolve({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }, '192.0.2.1')).toBe('198.51.100.1');
  });

  it('trusts a forwarded header from a listed IPv4 proxy', () => {
    expect(resolve({ 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.5', ['10.0.0.0/8'])).toBe('203.0.113.7');
  });

  // #241: an appending proxy such as nginx's default `proxy_add_x_forwarded_for` leaves a
  // client-supplied prefix in place, so only the right-hand side of the header is trustworthy.
  it('uses the real client behind an appending proxy, not a prepended spoofed value (#241)', () => {
    expect(resolve({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, '172.18.0.5', ['172.18.0.0/16'])).toBe('203.0.113.9');
  });

  it('walks several trusted hops from right to left and returns the first untrusted address', () => {
    expect(resolve({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.2, 10.0.0.3' }, '10.0.0.5', ['10.0.0.0/8'])).toBe('203.0.113.9');
  });

  it('returns the leftmost address when every forwarded address is a trusted proxy', () => {
    expect(resolve({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }, '10.0.0.5', ['10.0.0.0/8'])).toBe('10.0.0.1');
  });

  it('walks IPv6 hops and returns an untrusted IPv6 client', () => {
    expect(
      resolve({ 'x-forwarded-for': '2001:db8:dead::1, 2001:db8:1::5, 2001:db8:ffff::1' }, '2001:db8:ffff::1', ['2001:db8:ffff::/48']),
    ).toBe('2001:db8:1::5');
  });

  it('skips malformed header entries while walking from the right', () => {
    expect(resolve({ 'x-forwarded-for': 'garbage, 203.0.113.9, 172.18.0.5' }, '172.18.0.5', ['172.18.0.0/16'])).toBe('203.0.113.9');
  });

  it('handles an IPv4-mapped remote address against an IPv4 proxy range', () => {
    expect(resolve({ 'cf-connecting-ip': '198.51.100.9' }, '::ffff:10.0.0.5', ['10.0.0.0/8'])).toBe('198.51.100.9');
    expect(resolve({}, '::ffff:10.0.0.5', ['10.0.0.0/8'])).toBe('10.0.0.5');
  });

  it('ignores spoofed headers when the remote address is not a trusted proxy', () => {
    expect(resolve({ 'cf-connecting-ip': '1.2.3.4' }, '203.0.113.9', ['10.0.0.0/8'])).toBe('203.0.113.9');
  });

  it('trusts headers when no proxy list is configured (backward compatibility)', () => {
    expect(resolve({ 'cf-connecting-ip': '1.2.3.4' }, '192.0.2.1', [])).toBe('1.2.3.4');
  });

  it('falls back to the socket address when no header is present', () => {
    expect(resolve({}, '192.0.2.5', [])).toBe('192.0.2.5');
  });

  it('skips an invalid header and uses the next one', () => {
    expect(resolve({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.7' }, '192.0.2.1')).toBe('198.51.100.7');
  });

  it('never returns a non-IP value', () => {
    expect(resolve({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'also-bad' }, undefined)).toBeUndefined();
  });
});

describe('normalizeIp', () => {
  it('strips brackets, IPv6 zones, and the IPv4-mapped prefix', () => {
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('::ffff:10.0.0.5')).toBe('10.0.0.5');
  });

  it('rejects values that are not IP addresses', () => {
    expect(normalizeIp('not an ip')).toBeUndefined();
    expect(normalizeIp('  ')).toBeUndefined();
    expect(normalizeIp(undefined)).toBeUndefined();
  });
});

describe('isIpOrCidr', () => {
  it('accepts IP addresses and CIDR ranges', () => {
    expect(isIpOrCidr('10.0.0.5')).toBe(true);
    expect(isIpOrCidr('10.0.0.0/8')).toBe(true);
    expect(isIpOrCidr('127.0.0.1/32')).toBe(true);
    expect(isIpOrCidr('::1')).toBe(true);
    expect(isIpOrCidr('2001:db8::/32')).toBe(true);
  });

  it('rejects malformed ranges and out-of-range prefixes', () => {
    expect(isIpOrCidr('10.0.0.0/33')).toBe(false);
    expect(isIpOrCidr('::1/129')).toBe(false);
    expect(isIpOrCidr('nope')).toBe(false);
    expect(isIpOrCidr('10.0.0.0/')).toBe(false);
    expect(isIpOrCidr('/8')).toBe(false);
    expect(isIpOrCidr('10.0.0.0/8/9')).toBe(false);
    expect(isIpOrCidr('')).toBe(false);
  });
});

describe('remoteAddressFromEnv', () => {
  it('reads the Hono Node adapter socket address in both shapes', () => {
    expect(remoteAddressFromEnv({ incoming: { socket: { remoteAddress: '10.0.0.5' } } })).toBe('10.0.0.5');
    expect(remoteAddressFromEnv({ server: { incoming: { socket: { remoteAddress: '::1' } } } })).toBe('::1');
    expect(remoteAddressFromEnv(undefined)).toBeUndefined();
  });
});
