import { describe, expect, it } from 'vitest';
import {
  createWorkspaceDomainResolver,
  DomainError,
  normalizeDomainInput,
  normalizeHost,
  normalizePathPrefix,
  normalizeRequestPath,
  originForHost,
  pathMatchesPrefix,
  type WorkspaceDomain,
} from '../src/domains';
import type { Db } from '../src/pool';

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

  it('refuses an explicit non-default port for registration, but not for a request Host (#481)', () => {
    expect(() => normalizeDomainInput({ host: 'https://example.com:8443' })).toThrow(/port/i);
    expect(() => normalizeDomainInput({ host: 'http://localhost:3000' })).toThrow(/port/i);
    expect(normalizeDomainInput({ host: 'https://example.com:443' })).toEqual({ host: 'example.com', pathPrefix: null });
    expect(normalizeDomainInput({ host: 'example.com:443' })).toEqual({ host: 'example.com', pathPrefix: null });
    // Request Host headers may carry any port; it is stripped for matching.
    expect(normalizeHost('192.168.1.20:8080')).toBe('192.168.1.20');
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
    expect(originForHost('2001:db8::1')).toBe('https://[2001:db8::1]');
  });
});

describe('domain resolver cache', () => {
  const row = (over: Partial<WorkspaceDomain> = {}): WorkspaceDomain => ({
    id: 'wdo_1',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    host: 'brand.example',
    pathPrefix: null,
    isPrimary: true,
    status: 'verified',
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  /** A Db whose domain query can be held open, so a load can span an invalidation. */
  const fakeDb = (initial: WorkspaceDomain[]) => {
    let rows = initial;
    let holdNext = false;
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    let activeSetting = false;
    const db = {
      admin: {
        query: async (text: string) => {
          if (text.includes('installation_settings')) {
            if (text.trimStart().startsWith('INSERT')) {
              activeSetting = true;
              return { rows: [] };
            }
            return { rows: activeSetting ? [{ key: 'domain_routing_active' }] : [] };
          }
          if (holdNext) {
            holdNext = false;
            const snapshot = rows;
            await gate;
            return { rows: snapshot };
          }
          return { rows };
        },
      },
    };
    return {
      db: db as unknown as Db,
      holdNext() {
        holdNext = true;
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      setRows(next: WorkspaceDomain[]) {
        rows = next;
      },
      release() {
        release();
      },
    };
  };

  it('does not let an in-flight load repopulate the cache after invalidate (#464)', async () => {
    const fake = fakeDb([row()]);
    const resolver = createWorkspaceDomainResolver(fake.db, { ttlMs: 60_000 });
    // Hold the first registry load open, invalidate while it is in flight, then let it finish.
    fake.holdNext();
    const inFlight = resolver.resolveWorkspaceForRequest('brand.example', '/f/x');
    resolver.invalidate();
    fake.setRows([]);
    fake.release();
    // The request that started before the invalidation may still see its own answer…
    expect((await inFlight)?.domain.host).toBe('brand.example');
    // …but the pre-invalidation rows must not have been cached for the following request.
    expect(await resolver.resolveWorkspaceForRequest('brand.example', '/f/x')).toBeNull();
  });

  it('keeps Host checking on after the last verified domain is removed (#463)', async () => {
    const fake = fakeDb([row()]);
    const resolver = createWorkspaceDomainResolver(fake.db, { ttlMs: 0 });
    expect(await resolver.hostCheckingActive()).toBe(true);
    await resolver.activateHostChecking();
    fake.setRows([]);
    expect(await resolver.hostCheckingActive()).toBe(true);
  });

  it('quarantines rows on an installation-owned host (#480)', async () => {
    const fake = fakeDb([row({ id: 'wdo_takeover', host: 'links.example.com', workspaceId: 'ws_a' })]);
    const resolver = createWorkspaceDomainResolver(fake.db, { ttlMs: 0, reservedHosts: ['links.example.com'] });
    expect(await resolver.resolveWorkspaceForRequest('links.example.com', '/f/x')).toBeNull();
    expect(await resolver.linksUrlFor('ws_a')).toBeNull();
    // The quarantined row does not switch Host checking on by itself either.
    expect(await resolver.hostCheckingActive()).toBe(false);
  });
});
