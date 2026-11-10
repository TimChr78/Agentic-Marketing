import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://am:am@localhost:5432/am',
  APP_DB_PASSWORD: 'am_app_password',
  AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('configuration', () => {
  it('treats empty variables (as docker compose passes them) as not set', () => {
    const c = loadConfig({
      ...base,
      PUBLIC_URL: 'https://am.example.com',
      PUBLIC_LINKS_URL: '',
      MASTER_KEY_PREVIOUS: '',
      RETENTION_LOG_DAYS: '',
    });
    expect(c.linksUrl).toBe('https://am.example.com');
    expect(c.previousMasterKeys).toEqual([]);
    expect(c.retention).toEqual({ unconfirmedDays: 30, logDays: 180, hostedAgentRunDays: 90 });
  });

  it('fails fast with the setting that is wrong', () => {
    expect(() => loadConfig({ ...base, PUBLIC_LINKS_URL: 'not a url' })).toThrow('PUBLIC_LINKS_URL');
  });

  // Docker Compose substitutes POSTGRES_PASSWORD into DATABASE_URL verbatim, and a base64 password
  // contains `/` about half the time; a raw TypeError from new URL() escaped main.ts's ConfigError
  // path and killed the container with a stack trace (#647).
  it('turns an unparseable DATABASE_URL into a ConfigError that names the likely cause (#647)', () => {
    let error: unknown;
    try {
      loadConfig({ ...base, DATABASE_URL: 'postgres://am:abc/def@postgres:5432/am' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).name).toBe('ConfigError');
    expect((error as Error).message).toContain('Configuration is incomplete: DATABASE_URL is not a valid URL');
    expect((error as Error).message).toMatch(/percent-encoded/);
    expect((error as Error).message).toContain('openssl rand -hex 32');
  });

  it('accepts a percent-encoded password in DATABASE_URL (#647)', () => {
    const c = loadConfig({ ...base, DATABASE_URL: 'postgres://am:abc%2Fdef@postgres:5432/am' });
    // The app role replaces the owner credentials, and the URL setter encodes them.
    expect(new URL(c.appDatabaseUrl).password).toBe('am_app_password');
    expect(new URL(c.appDatabaseUrl).hostname).toBe('postgres');
  });

  it('parses client IP headers as an ordered, lowercased, de-duplicated list', () => {
    const c = loadConfig({ ...base, CLIENT_IP_HEADER: ' CF-Connecting-IP, X-Forwarded-For,cf-connecting-ip ,, ' });
    expect(c.clientIpHeaders).toEqual(['cf-connecting-ip', 'x-forwarded-for']);
    expect(c.clientIpHeader).toBe('cf-connecting-ip');
  });

  it('defaults to x-forwarded-for and keeps it as the first client IP header', () => {
    const c = loadConfig(base);
    expect(c.clientIpHeaders).toEqual(['x-forwarded-for']);
    expect(c.clientIpHeader).toBe('x-forwarded-for');
  });

  it('parses trusted proxy CIDRs, trimming entries and dropping empties', () => {
    const c = loadConfig({ ...base, TRUSTED_PROXY_CIDRS: '127.0.0.1/32, ::1/128 , 10.0.0.0/8,' });
    expect(c.trustedProxyCidrs).toEqual(['127.0.0.1/32', '::1/128', '10.0.0.0/8']);
  });

  it('defaults to an empty trusted proxy list so forwarding headers are ignored (#378)', () => {
    expect(loadConfig(base).trustedProxyCidrs).toEqual([]);
  });

  it('rejects an invalid TRUSTED_PROXY_CIDRS entry', () => {
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: '127.0.0.1/32,not-a-cidr' })).toThrow('TRUSTED_PROXY_CIDRS');
  });

  it('defaults webDist to apps/web/dist in the repo', () => {
    const c = loadConfig(base);
    expect(c.webDist.endsWith('/apps/web/dist')).toBe(true);
  });

  it('respects an explicit WEB_DIST', () => {
    const c = loadConfig({ ...base, WEB_DIST: '/srv/agentic-marketing/ui' });
    expect(c.webDist).toBe('/srv/agentic-marketing/ui');
  });

  it('keeps PUBLIC_PORT optional and parses it when set', () => {
    expect(loadConfig(base).publicPort).toBeUndefined();
    expect(loadConfig({ ...base, PUBLIC_PORT: '3001' }).publicPort).toBe(3001);
  });

  it('defaults the asset size limit to 5 MB and parses an override', () => {
    expect(loadConfig(base).assetMaxBytes).toBe(5_242_880);
    expect(loadConfig({ ...base, ASSET_MAX_BYTES: '1048576' }).assetMaxBytes).toBe(1_048_576);
  });

  it('accepts the four runtime roles, alone or comma-separated', () => {
    expect([...loadConfig({ ...base, ROLE: 'worker' }).roles]).toEqual(['worker']);
    expect([...loadConfig({ ...base, ROLE: 'api, ingest' }).roles]).toEqual(['api', 'ingest']);
    expect([...loadConfig(base).roles]).toEqual(['api', 'ingest', 'worker', 'scheduler']);
  });

  it('accepts ROLE=all with surrounding whitespace as every role, not a raw validation error (Sol 0.14.3 P3)', () => {
    expect([...loadConfig({ ...base, ROLE: ' all ' }).roles].sort()).toEqual(['api', 'ingest', 'scheduler', 'worker']);
  });

  it('rejects a ROLE that is not one of the four, instead of starting a process that serves nothing (#651)', () => {
    expect(() => loadConfig({ ...base, ROLE: 'decide' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ROLE: 'decide' })).toThrow('ROLE has unknown role "decide"');
    expect(() => loadConfig({ ...base, ROLE: 'api,decide' })).toThrow('ROLE has unknown role "decide"');
    expect(() => loadConfig({ ...base, ROLE: 'api,' })).toThrow(ConfigError);
  });
});
