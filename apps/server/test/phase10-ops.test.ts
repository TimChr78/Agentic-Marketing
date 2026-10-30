import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chainKeyProviders, localKeyProvider, open, readSecret, rewrapDataKeys, seal } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { keyProviderFor } from '../src/keys';
import { startTestServer, testPort, type User } from './harness';

// Phase 10 (wave 2), part c: operations. A workspace moves its data keys from MASTER_KEY to
// OpenBao Transit with `cli rotate-keys` (rewrapDataKeys) and keeps reading its secrets. Against a
// real OpenBao when OPENBAO_TEST_ADDR is set, otherwise a stand-in that speaks Transit.

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64'); // the harness's key
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let fake: Server | undefined;
let bao = { addr: process.env.OPENBAO_TEST_ADDR ?? '', token: process.env.OPENBAO_TEST_TOKEN ?? 'root' };

beforeAll(async () => {
  if (!bao.addr) {
    const k = Buffer.alloc(32, 5);
    fake = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      const reply = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      if (req.headers['x-vault-token'] !== 'root') return res.writeHead(403).end('{}');
      if (req.url?.startsWith('/v1/transit/encrypt/')) {
        const s = seal(k, Buffer.from(body.plaintext, 'base64'));
        return reply({ ciphertext: `vault:v1:${Buffer.concat([s.iv, s.authTag, s.ciphertext]).toString('base64')}` });
      }
      if (req.url?.startsWith('/v1/transit/decrypt/')) {
        const b = Buffer.from(String(body.ciphertext).slice('vault:v1:'.length), 'base64');
        return reply({
          plaintext: open(k, { iv: b.subarray(0, 12), authTag: b.subarray(12, 28), ciphertext: b.subarray(28) }).toString('base64'),
        });
      }
      res.writeHead(200).end('{}'); // mounts and keys
    });
    await new Promise<void>((r) => fake?.listen(0, '127.0.0.1', r));
    bao = { addr: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, token: 'root' };
  }
  const h = { 'x-vault-token': bao.token, 'content-type': 'application/json' };
  await fetch(`${bao.addr}/v1/sys/mounts/transit`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'transit' }) });
  await fetch(`${bao.addr}/v1/transit/keys/agentic-marketing`, { method: 'POST', headers: h, body: '{}' });

  t = await startTestServer('test_p10_ops', testPort(3289));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);
afterAll(async () => {
  await t?.close();
  fake?.close();
});

describe('key providers', () => {
  it('refuses a configuration that names a provider without its settings', () => {
    const base = { DATABASE_URL: 'postgres://x@localhost/x', APP_DB_PASSWORD: 'password-1', AUTH_SECRET: 'a'.repeat(32) };
    expect(() => loadConfig({ ...base })).toThrow(/KEY_PROVIDER=local needs MASTER_KEY/);
    expect(() => loadConfig({ ...base, KEY_PROVIDER: 'openbao', OPENBAO_ADDR: 'http://bao:8200' })).toThrow(
      /OPENBAO_TOKEN or OPENBAO_TOKEN_FILE/,
    );
    expect(() => loadConfig({ ...base, KEY_PROVIDER: 'aws-kms', AWS_REGION: 'eu-north-1' })).toThrow(/AWS_KMS_KEY_ID/);
    expect(loadConfig({ ...base, KEY_PROVIDER: 'openbao', OPENBAO_ADDR: 'http://bao:8200', OPENBAO_TOKEN: 't' }).keys.provider).toBe(
      'openbao',
    );
  });

  it('moves every data key from MASTER_KEY to OpenBao, and secrets stay readable', async () => {
    await t.api(owner).call('secrets.set', { name: 'llm.openai.api_key', value: 'sk-moving-0123456789' });
    const config = loadConfig({
      DATABASE_URL: 'postgres://x@localhost/x',
      APP_DB_PASSWORD: 'password-1',
      AUTH_SECRET: 'a'.repeat(32),
      KEY_PROVIDER: 'openbao',
      OPENBAO_ADDR: bao.addr,
      OPENBAO_TOKEN: bao.token,
      MASTER_KEY,
    });
    const kp = keyProviderFor(config);
    expect(kp.id).toBe('openbao:transit/agentic-marketing');
    const moved = await rewrapDataKeys(t.srv.db.admin, kp);
    expect(moved.rewrapped).toBeGreaterThan(0);
    const { rows } = await t.srv.db.admin.query('SELECT DISTINCT kek_id FROM data_keys WHERE workspace_id = $1', [ws]);
    expect(rows).toEqual([{ kek_id: 'openbao:transit/agentic-marketing' }]);
    const read = (p: typeof kp) => t.srv.db.withWorkspace(ws, (tx) => readSecret(tx, ws, 'llm.openai.api_key', p));
    // Without MASTER_KEY: OpenBao alone unwraps now.
    expect(await read(keyProviderFor({ ...config, masterKey: undefined }))).toBe('sk-moving-0123456789');
    await expect(read(localKeyProvider(MASTER_KEY))).rejects.toThrow();
    // Back to the local key, so the running server (MASTER_KEY) keeps working for other tests.
    await rewrapDataKeys(t.srv.db.admin, chainKeyProviders(localKeyProvider(MASTER_KEY), [kp]));
    expect(await read(localKeyProvider(MASTER_KEY))).toBe('sk-moving-0123456789');
  });
});
