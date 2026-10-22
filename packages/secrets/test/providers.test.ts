import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localKeyProvider, newDataKey, open, seal } from '../src/keys';
import { awsKmsKeyProvider, cachedKeyProvider, chainKeyProviders, openbaoKeyProvider } from '../src/providers';

// Remote KEKs. Fake servers stand in for OpenBao Transit and AWS KMS (sealing with a local key,
// checking what a real one checks); with OPENBAO_TEST_ADDR and OPENBAO_TEST_TOKEN set (CI runs
// OpenBao in dev mode), the same round trip also runs against a real OpenBao.

const serverKey = Buffer.alloc(32, 9);
const requests: { path: string; headers: IncomingMessage['headers']; body: Record<string, string> }[] = [];
let validToken = 'root-token';
let server: Server;
let base = '';

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const sealB64 = (plain: Buffer) => {
  const s = seal(serverKey, plain);
  return Buffer.concat([s.iv, s.authTag, s.ciphertext]).toString('base64');
};
const openB64 = (b64: string) => {
  const b = Buffer.from(b64, 'base64');
  return open(serverKey, { iv: b.subarray(0, 12), authTag: b.subarray(12, 28), ciphertext: b.subarray(28) });
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ path: req.url ?? '', headers: req.headers, body });
    if (req.url?.startsWith('/v1/transit/')) {
      if (req.headers['x-vault-token'] !== validToken) return json(res, 403, { errors: ['permission denied'] });
      if (req.url === '/v1/transit/encrypt/am')
        return json(res, 200, { data: { ciphertext: `vault:v1:${sealB64(Buffer.from(body.plaintext, 'base64'))}` } });
      if (req.url === '/v1/transit/decrypt/am')
        return json(res, 200, { data: { plaintext: openB64(body.ciphertext.replace('vault:v1:', '')).toString('base64') } });
    }
    if (req.url === '/kms/') {
      const auth = String(req.headers.authorization ?? '');
      if (!/^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-north-1\/kms\/aws4_request/.test(auth))
        return json(res, 400, { message: 'bad signature' });
      if (req.headers['x-amz-target'] === 'TrentService.Encrypt')
        return json(res, 200, { CiphertextBlob: sealB64(Buffer.from(body.Plaintext, 'base64')) });
      if (req.headers['x-amz-target'] === 'TrentService.Decrypt')
        return json(res, 200, { Plaintext: openB64(body.CiphertextBlob).toString('base64') });
    }
    json(res, 404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

describe('OpenBao Transit', () => {
  it('wraps and unwraps through the server, and the stored blob is the Transit ciphertext', async () => {
    const kp = openbaoKeyProvider({ addr: base, key: 'am', token: 'root-token' });
    const dk = newDataKey();
    const wrapped = await kp.wrap(dk);
    expect(wrapped.toString('utf8')).toMatch(/^vault:v1:/);
    expect(await kp.unwrap(wrapped, kp.id)).toEqual(dk);
    expect(kp.id).toBe('openbao:transit/am');
  });

  it('re-reads a token file when the server rejects the token (renewed by a sidecar)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'bao-')), 'token');
    await writeFile(file, 'root-token\n');
    const kp = openbaoKeyProvider({ addr: base, key: 'am', tokenFile: file });
    const wrapped = await kp.wrap(newDataKey());
    validToken = 'renewed-token';
    await writeFile(file, 'renewed-token');
    expect(await kp.unwrap(wrapped, kp.id)).toHaveLength(32);
    validToken = 'root-token';
  });
});

describe('AWS KMS', () => {
  it('signs Encrypt and Decrypt with SigV4 for the kms service', async () => {
    const kp = awsKmsKeyProvider({
      keyId: 'alias/agentic-marketing',
      region: 'eu-north-1',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      endpoint: `${base}/kms/`,
    });
    const dk = newDataKey();
    expect(await kp.unwrap(await kp.wrap(dk), kp.id)).toEqual(dk);
    const last = requests.filter((r) => r.path === '/kms/').at(-1);
    expect(last?.body.KeyId).toBe('alias/agentic-marketing');
  });
});

describe('moving between providers', () => {
  it('unwraps keys of the previous provider and wraps new ones with the current one', async () => {
    const local = localKeyProvider(Buffer.alloc(32, 4).toString('base64'));
    const bao = openbaoKeyProvider({ addr: base, key: 'am', token: 'root-token' });
    const old = newDataKey();
    const oldWrapped = await local.wrap(old);
    const chain = chainKeyProviders(bao, [local]);
    expect(chain.id).toBe(bao.id);
    expect(await chain.unwrap(oldWrapped, local.id)).toEqual(old);
    const fresh = newDataKey();
    expect((await chain.wrap(fresh)).toString('utf8')).toMatch(/^vault:v1:/);
    await expect(chain.unwrap(oldWrapped, 'aws-kms:other')).rejects.toThrow(/No configured key provider/);
  });

  it('caches unwrapped keys, so a remote KEK is called once per data key', async () => {
    const bao = openbaoKeyProvider({ addr: base, key: 'am', token: 'root-token' });
    const kp = cachedKeyProvider(bao);
    const wrapped = await kp.wrap(newDataKey());
    const before = requests.length;
    for (let i = 0; i < 5; i++) await kp.unwrap(wrapped, kp.id);
    expect(requests.length - before).toBe(1);
  });
});

describe.runIf(process.env.OPENBAO_TEST_ADDR)('a real OpenBao', () => {
  it('round-trips a data key through Transit', async () => {
    const addr = process.env.OPENBAO_TEST_ADDR as string;
    const token = process.env.OPENBAO_TEST_TOKEN ?? 'root';
    const h = { 'x-vault-token': token, 'content-type': 'application/json' };
    // Dev mode starts without Transit: enable it and create a key (ignoring "already exists").
    await fetch(`${addr}/v1/sys/mounts/transit`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'transit' }) });
    await fetch(`${addr}/v1/transit/keys/agentic-marketing`, { method: 'POST', headers: h, body: '{}' });
    const kp = openbaoKeyProvider({ addr, token, key: 'agentic-marketing' });
    const dk = newDataKey();
    expect(await kp.unwrap(await kp.wrap(dk), kp.id)).toEqual(dk);
  });
});
