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
});
