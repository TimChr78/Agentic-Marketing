import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AwsClient } from 'aws4fetch';
import type { KeyProvider } from './keys';

// Key-encryption keys held outside the application: OpenBao (or HashiCorp Vault) Transit and AWS
// KMS. Either wraps the workspaces' data keys; the plaintext KEK never reaches this process.
// Moving from MASTER_KEY to one of them: configure it as current with the old local key as
// previous (chainKeyProviders), run `cli rotate-keys`, then drop MASTER_KEY.

type Fetch = typeof fetch;

async function call<T>(f: Fetch, url: string, init: RequestInit, what: string): Promise<T> {
  const res = await f(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/**
 * OpenBao / Vault Transit. The token comes from `token` or is read from `tokenFile` (as written by
 * an agent sidecar or a Kubernetes projected secret), re-read when the server rejects it.
 */
export function openbaoKeyProvider(o: {
  addr: string;
  key: string;
  mount?: string;
  token?: string;
  tokenFile?: string;
  namespace?: string;
  fetch?: Fetch;
}): KeyProvider {
  const f = o.fetch ?? fetch;
  const mount = o.mount ?? 'transit';
  const base = `${o.addr.replace(/\/$/, '')}/v1/${mount}`;
  let token: Promise<string> | undefined;
  const readToken = () => (o.token ? Promise.resolve(o.token) : readFile(o.tokenFile ?? '', 'utf8').then((t) => t.trim()));
  async function post<T>(path: string, body: unknown, retried = false): Promise<T> {
    token ??= readToken();
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-vault-token': await token };
    if (o.namespace) headers['x-vault-namespace'] = o.namespace;
    try {
      return await call<T>(
        f,
        `${base}/${path}/${encodeURIComponent(o.key)}`,
        { method: 'POST', headers, body: JSON.stringify(body) },
        `OpenBao ${path}`,
      );
    } catch (err) {
      if (!retried && o.tokenFile && /HTTP 403/.test((err as Error).message)) {
        token = undefined;
        return post(path, body, true);
      }
      throw err;
    }
  }
  return {
    id: `openbao:${mount}/${o.key}`,
    async wrap(dataKey) {
      const r = await post<{ data: { ciphertext: string } }>('encrypt', { plaintext: dataKey.toString('base64') });
      return Buffer.from(r.data.ciphertext, 'utf8');
    },
    async unwrap(wrapped) {
      const r = await post<{ data: { plaintext: string } }>('decrypt', { ciphertext: wrapped.toString('utf8') });
      return Buffer.from(r.data.plaintext, 'base64');
    },
  };
}

/** AWS KMS (Encrypt/Decrypt with a symmetric key), signed with SigV4. `endpoint` is for testing or VPC endpoints. */
export function awsKmsKeyProvider(o: {
  keyId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
  fetch?: Fetch;
}): KeyProvider {
  const aws = new AwsClient({
    accessKeyId: o.accessKeyId,
    secretAccessKey: o.secretAccessKey,
    sessionToken: o.sessionToken,
    region: o.region,
    service: 'kms',
  });
  const f = o.fetch ?? fetch;
  const url = o.endpoint ?? `https://kms.${o.region}.amazonaws.com/`;
  async function kms<T>(action: string, body: unknown) {
    const req = await aws.sign(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${action}` },
      body: JSON.stringify(body),
    });
    return call<T>(f, req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body) }, `AWS KMS ${action}`);
  }
  return {
    id: `aws-kms:${o.keyId}`,
    async wrap(dataKey) {
      const r = await kms<{ CiphertextBlob: string }>('Encrypt', { KeyId: o.keyId, Plaintext: dataKey.toString('base64') });
      return Buffer.from(r.CiphertextBlob, 'base64');
    },
    async unwrap(wrapped) {
      const r = await kms<{ Plaintext: string }>('Decrypt', { KeyId: o.keyId, CiphertextBlob: wrapped.toString('base64') });
      return Buffer.from(r.Plaintext, 'base64');
    },
  };
}

/**
 * The current provider wraps; unwrapping goes to whichever provider owns the stored KEK id, so data
 * keys wrapped by a previous provider keep working until `cli rotate-keys` re-wraps them.
 */
export function chainKeyProviders(current: KeyProvider, previous: KeyProvider[]): KeyProvider {
  const all = [current, ...previous];
  return {
    id: current.id,
    owns: (kekId) => all.some((p) => (p.owns ? p.owns(kekId) : p.id === kekId)),
    wrap: (dataKey) => current.wrap(dataKey),
    async unwrap(wrapped, kekId) {
      const owner = all.find((p) => (p.owns ? p.owns(kekId) : p.id === kekId));
      if (owner) return owner.unwrap(wrapped, kekId);
      // Ids from before fingerprints (no "scheme:" prefix): only a local key can tell by trying.
      if (!kekId.includes(':'))
        for (const p of all.filter((x) => x.id.startsWith('local-')))
          try {
            return await p.unwrap(wrapped, kekId);
          } catch {}
      throw new Error(`No configured key provider owns KEK ${kekId}. Is the previous key or provider still configured?`);
    },
  };
}

/**
 * Remembers unwrapped data keys for a while, so a remote KEK costs one call per data key and
 * interval rather than one per request. Wrapping is never cached.
 */
export function cachedKeyProvider(inner: KeyProvider, ttlMs = 10 * 60_000, max = 1000): KeyProvider {
  const cache = new Map<string, { key: Buffer; until: number }>();
  return {
    id: inner.id,
    owns: inner.owns,
    wrap: (dataKey) => inner.wrap(dataKey),
    async unwrap(wrapped, kekId) {
      const k = `${kekId}:${createHash('sha256').update(wrapped).digest('hex')}`;
      const hit = cache.get(k);
      if (hit && hit.until > Date.now()) return hit.key;
      const key = await inner.unwrap(wrapped, kekId);
      if (cache.size >= max) cache.delete(cache.keys().next().value as string);
      cache.set(k, { key, until: Date.now() + ttlMs });
      return key;
    },
  };
}
