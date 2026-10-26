import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import {
  type Check,
  checkConfig,
  checkEgress,
  checkPublicLinksUrl,
  checkPublicPort,
  checkPublicUrl,
  checkSendingDomains,
  checkTrustedProxyCidrs,
  type Env,
  envFileChecks,
  envFileKeys,
  liveChecks,
  offlineChecks,
} from '../src/ops/checks';

const good: Env = {
  AUTH_SECRET: 'a'.repeat(40),
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  POSTGRES_PASSWORD: 'p'.repeat(24),
  APP_DB_PASSWORD: 'a'.repeat(24),
  DATABASE_URL: 'postgres://am:am@localhost:5432/am',
  PUBLIC_URL: 'https://admin.example.com',
  PUBLIC_LINKS_URL: 'https://links.example.com',
  PUBLIC_PORT: '3001',
  TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
};

const check = (env: Env, id: string): Check | undefined => offlineChecks(env).find((item) => item.id === id);

afterEach(() => vi.restoreAllMocks());

describe('am doctor offline checks', () => {
  it('passes a complete configuration', () => {
    expect(offlineChecks(good).every((item) => item.status === 'ok')).toBe(true);
  });

  it('checks AUTH_SECRET', () => {
    expect(check({ ...good, AUTH_SECRET: '' }, 'secrets.auth-secret')?.status).toBe('fail');
    expect(check({ ...good, AUTH_SECRET: 'change-me' }, 'secrets.auth-secret')?.status).toBe('fail');
    expect(check({ ...good, AUTH_SECRET: 'short' }, 'secrets.auth-secret')?.status).toBe('fail');
    expect(check(good, 'secrets.auth-secret')?.status).toBe('ok');
  });

  it('checks MASTER_KEY, including the format the secrets package requires', () => {
    expect(check({ ...good, MASTER_KEY: '' }, 'secrets.master-key')?.status).toBe('fail');
    expect(check({ ...good, MASTER_KEY: 'change-me' }, 'secrets.master-key')?.status).toBe('fail');
    expect(check({ ...good, MASTER_KEY: Buffer.alloc(31, 7).toString('base64') }, 'secrets.master-key')?.status).toBe('fail');
    expect(check(good, 'secrets.master-key')?.status).toBe('ok');
    expect(check({ ...good, KEY_PROVIDER: 'openbao', MASTER_KEY: '' }, 'secrets.master-key')?.status).toBe('ok');
  });

  it('checks the two database passwords', () => {
    expect(check({ ...good, POSTGRES_PASSWORD: '' }, 'secrets.postgres-password')?.status).toBe('ok');
    expect(check({ ...good, POSTGRES_PASSWORD: 'change-me' }, 'secrets.postgres-password')?.status).toBe('fail');
    expect(check({ ...good, POSTGRES_PASSWORD: 'short' }, 'secrets.postgres-password')?.status).toBe('fail');
    expect(check(good, 'secrets.postgres-password')?.status).toBe('ok');

    expect(check({ ...good, APP_DB_PASSWORD: '' }, 'secrets.app-db-password')?.status).toBe('fail');
    expect(check({ ...good, APP_DB_PASSWORD: 'change-me-too' }, 'secrets.app-db-password')?.status).toBe('fail');
    expect(check({ ...good, APP_DB_PASSWORD: 'short' }, 'secrets.app-db-password')?.status).toBe('fail');
    expect(check(good, 'secrets.app-db-password')?.status).toBe('ok');
  });

  it('warns only when plain HTTP is not loopback', () => {
    expect(checkPublicUrl({ ...good, PUBLIC_URL: 'https://marketing.example.com' }).status).toBe('ok');
    expect(checkPublicUrl({ ...good, PUBLIC_URL: 'http://localhost:3000' }).status).toBe('ok');
    expect(checkPublicUrl({ ...good, PUBLIC_URL: 'http://127.0.0.1:3000' }).status).toBe('ok');
    const warned = checkPublicUrl({ ...good, PUBLIC_URL: 'http://192.168.1.20:3000' });
    expect(warned.status).toBe('warn');
    expect(warned.message).toContain('MCP is off');
    expect(checkPublicUrl({ ...good, PUBLIC_URL: 'not a url' }).status).toBe('fail');
    expect(checkPublicUrl({ ...good, PUBLIC_URL: 'ftp://marketing.example.com' }).status).toBe('fail');
  });

  it('checks PUBLIC_LINKS_URL', () => {
    const empty = checkPublicLinksUrl({ ...good, PUBLIC_LINKS_URL: '' });
    expect(empty.status).toBe('warn');
    expect(empty.message).toContain('links use PUBLIC_URL');
    expect(checkPublicLinksUrl({ ...good, PUBLIC_LINKS_URL: 'https://admin.example.com/am' }).status).toBe('warn');
    expect(checkPublicLinksUrl(good).status).toBe('ok');
    expect(checkPublicLinksUrl({ ...good, PUBLIC_LINKS_URL: 'nope' }).status).toBe('fail');
  });

  it('recommends a separate public listener and names the published address', () => {
    const missing = checkPublicPort({ ...good, PUBLIC_PORT: '' });
    expect(missing.status).toBe('warn');
    expect(missing.hint).toContain('PUBLIC_BIND');
    expect(missing.hint).toContain('127.0.0.1:3210');
    expect(missing.hint).toContain('ports: !override');
    expect(checkPublicPort(good).status).toBe('ok');
    expect(checkPublicPort({ ...good, PUBLIC_BIND: '0.0.0.0:3101' }).message).toContain('0.0.0.0:3101');
    expect(checkPublicPort({ ...good, PUBLIC_PORT: '70000' }).status).toBe('fail');
  });

  it('warns when forwarded headers are trusted from anywhere', () => {
    const empty = checkTrustedProxyCidrs({ ...good, TRUSTED_PROXY_CIDRS: '' });
    expect(empty.status).toBe('warn');
    expect(empty.message).toContain('any source');
    expect(checkTrustedProxyCidrs(good).status).toBe('ok');
  });

  it('reports configuration errors without throwing', () => {
    const invalid = checkConfig({ AUTH_SECRET: 'short' });
    expect(invalid.check.status).toBe('fail');
    expect(invalid.config).toBeUndefined();
    expect(invalid.check.message).toContain('AUTH_SECRET');
    expect(checkConfig(good).check.status).toBe('ok');
  });

  it('parses uncommented and documented keys', () => {
    const text = '# Copy to .env\nAUTH_SECRET=x\n# PUBLIC_PORT=3001\nexport DATABASE_URL=y\n';
    expect(envFileKeys(text)).toEqual(['AUTH_SECRET', 'DATABASE_URL']);
    expect(envFileKeys(text, true)).toEqual(['AUTH_SECRET', 'PUBLIC_PORT', 'DATABASE_URL']);
  });

  it('reports unknown keys but ignores Compose and Docker variables', () => {
    const example = 'AM_VERSION=0.2.4\nAUTH_SECRET=\n';
    const unknown = envFileChecks(
      'AM_VERSION=0.2.4\nAUTH_SECRET=x\nCOMPOSE_FILE=./compose.yaml\nDOCKER_HOST=tcp://example\nOLD_KEY=1\n',
      example,
    );
    expect(unknown.find((item) => item.id === 'env-file.unknown')?.status).toBe('warn');
    expect(unknown.find((item) => item.id === 'env-file.unknown')?.message).toContain('OLD_KEY');
    expect(unknown.find((item) => item.id === 'env-file.unknown')?.message).not.toContain('COMPOSE_FILE');
    expect(unknown.find((item) => item.id === 'env-file.unknown')?.message).not.toContain('DOCKER_HOST');
  });

  it('reports only variables added after the version the file comes from', () => {
    const example = 'AM_VERSION=0.2.4\nAUTH_SECRET=\nAPP_DB_PASSWORD=\n# SKIP_PRE_UPGRADE_BACKUP=false\n';
    const older = envFileChecks('AM_VERSION=0.2.3\nAUTH_SECRET=x\nAPP_DB_PASSWORD=y\n', example, '0.2.3');
    const missing = older.find((item) => item.id === 'env-file.missing');
    expect(missing?.status).toBe('info');
    expect(missing?.message).toContain('SKIP_PRE_UPGRADE_BACKUP');
    expect(missing?.message).not.toContain('ASSET_MAX_BYTES');
    expect(missing?.message).not.toContain('WEB_DIST');
    expect(missing?.message).not.toContain('DATABASE_URL');

    const current = envFileChecks('AM_VERSION=0.2.4\nAUTH_SECRET=x\nAPP_DB_PASSWORD=y\n', example, '0.2.4');
    expect(current.find((item) => item.id === 'env-file.missing')?.status).toBe('ok');
    expect(current.find((item) => item.id === 'env-file.missing')?.message).toContain('no variables added since 0.2.4');
  });

  it('takes the from-version from AM_VERSION and warns only about new required keys', () => {
    const example = 'AM_VERSION=0.2.4\nAUTH_SECRET=\nAPP_DB_PASSWORD=\n';
    const fromFile = envFileChecks('AM_VERSION=0.2.3\nAUTH_SECRET=x\nAPP_DB_PASSWORD=y\n', example);
    expect(fromFile.find((item) => item.id === 'env-file.missing')?.status).toBe('info');

    const unknownVersion = envFileChecks('AUTH_SECRET=x\nAPP_DB_PASSWORD=y\n', example);
    expect(unknownVersion.find((item) => item.id === 'env-file.missing')?.status).toBe('info');

    const required = envFileChecks('AM_VERSION=0.1.0\nDATABASE_URL=y\n', example, '0.0.0');
    const requiredCheck = required.find((item) => item.id === 'env-file.missing');
    expect(requiredCheck?.status).toBe('warn');
    expect(requiredCheck?.message).toContain('AUTH_SECRET');
  });

  it('accepts Compose-supplied and internal values as absent', () => {
    const example = 'DATABASE_URL=\nWEB_DIST=\nTRUSTED_ORIGINS=\nPORT=\nAUTH_SECRET=\nAPP_DB_PASSWORD=\n';
    const checks = envFileChecks('AUTH_SECRET=x\nAPP_DB_PASSWORD=y\n', example, '0.0.0');
    const message = checks.find((item) => item.id === 'env-file.missing')?.message ?? '';
    for (const key of ['DATABASE_URL', 'WEB_DIST', 'TRUSTED_ORIGINS', 'PORT']) expect(message, key).not.toContain(`${key} (`);
  });

  it('does not require providers for DNS and egress', async () => {
    const [dns] = await checkSendingDomains([]);
    const [egress] = await checkEgress([]);
    expect(dns.status).toBe('ok');
    expect(egress.status).toBe('ok');
  });
});

describe('am doctor sending-domain checks', () => {
  const provider = (from_email: string) => [{ adapter: 'log', from_email, config: null }];

  it('inherits DMARC from the organizational domain', async () => {
    const looked: string[] = [];
    const lookup = async (name: string) => {
      looked.push(name);
      if (name === 'mail.example.com') return ['v=spf1 include:example.net -all'];
      if (name === '_dmarc.example.com') return ['v=DMARC1; p=quarantine; adkim=s'];
      return [];
    };
    const [check] = await checkSendingDomains(provider('news@mail.example.com'), lookup);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('inherited from example.com (p=quarantine)');
    expect(looked).toContain('_dmarc.mail.example.com');
    expect(looked).toContain('_dmarc.example.com');
  });

  it('treats known two-label public suffixes as organizational domains', async () => {
    const looked: string[] = [];
    const lookup = async (name: string) => {
      looked.push(name);
      if (name === 'shop.example.co.uk') return ['v=spf1 -all'];
      if (name === '_dmarc.example.co.uk') return ['v=DMARC1; p=reject'];
      return [];
    };
    const [check] = await checkSendingDomains(provider('news@shop.example.co.uk'), lookup);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('inherited from example.co.uk (p=reject)');
    expect(looked).not.toContain('_dmarc.co.uk');
  });

  it('warns when no DMARC record exists anywhere', async () => {
    const lookup = async (name: string) => (name === 'example.com' ? ['v=spf1 -all'] : []);
    const [check] = await checkSendingDomains(provider('news@example.com'), lookup);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('missing DMARC');
  });

  it('warns when the effective policy is p=none', async () => {
    const lookup = async (name: string) => {
      if (name === 'example.com') return ['v=spf1 -all'];
      if (name === '_dmarc.example.com') return ['v=DMARC1; p=none; rua=mailto:dmarc@example.com'];
      return [];
    };
    const [check] = await checkSendingDomains(provider('news@example.com'), lookup);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('p=none');
  });
});

describe('am doctor live checks', () => {
  const dbName = `am_doctor_${process.pid}_${randomBytes(4).toString('hex')}`;
  const basePgUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test');
  const maintenanceUrl = Object.assign(new URL(basePgUrl), { pathname: '/postgres' }).toString();
  const dbUrl = Object.assign(new URL(basePgUrl), { pathname: `/${dbName}` }).toString();

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: maintenanceUrl });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${dbName}`);
    await client.end();
  });

  afterAll(async () => {
    const client = new pg.Client({ connectionString: maintenanceUrl });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.end();
  });

  it('reports the local services and no provider failures', async () => {
    const config = loadConfig({
      DATABASE_URL: dbUrl,
      APP_DB_ROLE: 'am_app_test',
      APP_DB_PASSWORD: 'am_app_test_password',
      AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
      CLICKHOUSE_DATABASE: dbName,
      CLICKHOUSE_ROW_POLICIES: process.env.CLICKHOUSE_ROW_POLICIES ?? 'auto',
      NATS_URL: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
      NATS_NAMESPACE: dbName,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      VALKEY_PREFIX: dbName,
    });

    const checks = await liveChecks(config);
    const byId = new Map(checks.map((item) => [item.id, item]));
    for (const id of ['postgres', 'clickhouse', 'nats', 'valkey', 'dns', 'egress'])
      expect(byId.get(id)?.status, `${id}: ${JSON.stringify(byId.get(id))}`).toBe('ok');
    expect(byId.get('migrations')?.status).toBe('warn');
    expect(
      checks.filter((item) => item.status === 'fail'),
      JSON.stringify(checks),
    ).toEqual([]);
  }, 20_000);
});
