import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

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
    expect(c.retention).toEqual({ unconfirmedDays: 30, logDays: 180 });
  });

  it('fails fast with the setting that is wrong', () => {
    expect(() => loadConfig({ ...base, PUBLIC_LINKS_URL: 'not a url' })).toThrow('PUBLIC_LINKS_URL');
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
});
