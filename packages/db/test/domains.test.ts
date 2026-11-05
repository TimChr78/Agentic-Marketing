import { describe, expect, it } from 'vitest';
import {
  DomainError,
  normalizeDomainInput,
  normalizeHost,
  normalizePathPrefix,
  normalizeRequestPath,
  originForHost,
  pathMatchesPrefix,
} from '../src/domains';

// Host normalisation happens before anything is stored, so a typo or a wildcard is a clear error
// rather than a row that never matches. No database needed.

describe('normalizeHost', () => {
  it('lowercases, strips a port and a trailing root dot', () => {
    expect(normalizeHost('MartechSignal.COM:8443')).toBe('martechsignal.com');
    expect(normalizeHost('example.com.')).toBe('example.com');
    expect(normalizeHost('  Example.COM  ')).toBe('example.com');
  });

  it('converts international names to IDNA', () => {
    expect(normalizeHost('Bücher.Example')).toBe('xn--bcher-kva.example');
  });

  it('accepts a full https URL and ignores its trailing slash', () => {
    expect(normalizeHost('https://Links.Example.com/')).toBe('links.example.com');
  });

  it('allows plain http only on localhost', () => {
    expect(normalizeHost('http://localhost:3000')).toBe('localhost');
    expect(() => normalizeHost('http://links.example.com')).toThrow(/https/);
  });

  it('rejects wildcards, userinfo, queries, fragments and paths', () => {
    for (const value of ['*.example.com', 'user@example.com', 'example.com?x=1', 'example.com#top', 'https://example.com/am'])
      expect(() => normalizeHost(value), value).toThrow(DomainError);
  });

  it('rejects empty and malformed hosts with an actionable message', () => {
    expect(() => normalizeHost('')).toThrow(/hostname/i);
    expect(() => normalizeHost('not a host')).toThrow(/valid hostname/i);
    expect(() => normalizeHost('exa_mple.com')).toThrow(/valid hostname/i);
  });
});

describe('normalizePathPrefix', () => {
  it('normalises a prefix to a leading slash without a trailing slash', () => {
    expect(normalizePathPrefix('am')).toBe('/am');
    expect(normalizePathPrefix('/am/')).toBe('/am');
    expect(normalizePathPrefix('/brands/signal/')).toBe('/brands/signal');
    expect(normalizePathPrefix('/a//b')).toBe('/a/b');
  });

  it('treats empty and "/" as the whole host', () => {
    expect(normalizePathPrefix('')).toBeNull();
    expect(normalizePathPrefix('/')).toBeNull();
    expect(normalizePathPrefix(null)).toBeNull();
    expect(normalizePathPrefix(undefined)).toBeNull();
  });

  it('rejects traversal, queries, fragments and backslashes', () => {
    for (const value of ['/../admin', '/am/../x', '/am?x=1', '/am#x', '/am\\x'])
      expect(() => normalizePathPrefix(value), value).toThrow(DomainError);
  });
});

describe('domain inputs and request paths', () => {
  it('normalises both parts together', () => {
    expect(normalizeDomainInput({ host: 'https://Bücher.example/', pathPrefix: 'am/' })).toEqual({
      host: 'xn--bcher-kva.example',
      pathPrefix: '/am',
    });
  });

  it('strips query and fragment from a request path', () => {
    expect(normalizeRequestPath('/u/token?x=1#top')).toBe('/u/token');
    expect(normalizeRequestPath('u/token')).toBe('/u/token');
    expect(normalizeRequestPath('')).toBe('/');
  });

  it('matches a prefix only at a segment boundary', () => {
    expect(pathMatchesPrefix('/am', '/am')).toBe(true);
    expect(pathMatchesPrefix('/am/f/form', '/am')).toBe(true);
    expect(pathMatchesPrefix('/am2/f/form', '/am')).toBe(false);
    expect(pathMatchesPrefix('/anything', null)).toBe(true);
  });

  it('builds an origin with http only on loopback', () => {
    expect(originForHost('links.example.com')).toBe('https://links.example.com');
    expect(originForHost('localhost')).toBe('http://localhost');
    expect(originForHost('127.0.0.1')).toBe('http://127.0.0.1');
  });
});
