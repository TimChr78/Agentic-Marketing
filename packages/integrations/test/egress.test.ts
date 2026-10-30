import { createHmac } from 'node:crypto';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { createServer } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  checkUrl,
  type DnsResolve,
  type EgressPolicy,
  egressFetch,
  egressHttp2,
  isBlockedAddress,
  lookupFor,
  safeRequest,
} from '../src/egress';
import { newWebhookSecret, signWebhook, verifyHmac, verifyWebhook, webhookHeaders } from '../src/signing';

const none = { allowedHosts: [] };

const publicAddresses: LookupAddress[] = [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

const resolving =
  (addresses: LookupAddress[]): DnsResolve =>
  (_hostname, _options, cb) =>
    cb(null, addresses);

/** Call a guarded lookup as `net` does, turning the callback into a promise. */
function lookupOf(
  resolve: DnsResolve,
  options: LookupOptions,
  policy: EgressPolicy = none,
): Promise<{ address: string | LookupAddress[]; family?: number }> {
  const fn = lookupFor(new URL('https://example.com/hook'), policy, resolve);
  return new Promise((ok, fail) => fn('example.com', options, (err, address, family) => (err ? fail(err) : ok({ address, family }))));
}

describe('egress guard', () => {
  it('blocks private, loopback, link-local and metadata addresses unless allowed', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.5',
      '172.20.0.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ])
      expect(isBlockedAddress(a, none), a).toBe(true);
    expect(isBlockedAddress('93.184.216.34', none)).toBe(false);
    expect(isBlockedAddress('192.168.1.5', { allowedHosts: ['192.168.1.0/24'] })).toBe(false);
    expect(isBlockedAddress('192.168.2.5', { allowedHosts: ['192.168.1.0/24'] })).toBe(true);
  });

  it('checks URLs before any request', () => {
    expect(checkUrl('ftp://example.com', none)).toBe('only http and https URLs are allowed');
    expect(checkUrl('https://user:pw@example.com', none)).toContain('credentials');
    expect(checkUrl('http://localhost:5678/webhook', none)).toBe('localhost is an internal address');
    expect(checkUrl('http://localhost:5678/webhook', { allowedHosts: ['localhost'] })).toBeNull();
    expect(checkUrl('http://[::1]/x', none)).toContain('private address');
    expect(checkUrl('https://n8n.example.com/webhook/abc', none)).toBeNull();
  });

  it('refuses names that resolve to private addresses at connect time, and never follows redirects', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await expect(safeRequest(`http://localtest.me:${port}/`, {}, none)).rejects.toThrow(/private address|ENOTFOUND|EAI_AGAIN/);
    const res = await safeRequest(`http://127.0.0.1:${port}/`, {}, { allowedHosts: ['127.0.0.1'] });
    expect(res.status).toBe(302);
    srv.close();
  });

  it('honours all:true, the way autoSelectFamily calls the lookup', async () => {
    await expect(lookupOf(resolving(publicAddresses), { all: true })).resolves.toEqual({ address: publicAddresses });
    await expect(lookupOf(resolving(publicAddresses), { all: false })).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('refuses a mixed public/private answer instead of using its public address', async () => {
    const mixed: LookupAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    await expect(lookupOf(resolving(mixed), { all: true })).rejects.toThrow(/private address 10\.0\.0\.1/);
    await expect(lookupOf(resolving(mixed), { all: false })).rejects.toThrow(/private address 10\.0\.0\.1/);
    await expect(lookupOf(resolving([]), { all: true })).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('reaches a local server by name through safeRequest and egressFetch with Happy Eyeballs on', async () => {
    // Node 20+ defaults autoSelectFamily to true, which asks the custom lookup for every address.
    const previous = getDefaultAutoSelectFamily();
    setDefaultAutoSelectFamily(true);
    expect(getDefaultAutoSelectFamily()).toBe(true);
    const srv = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`ok ${req.method}`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    // `localhost` itself must be named, since checkUrl rejects internal names; the loops are allowed too.
    const policy = { allowedHosts: ['localhost', '127.0.0.1', '::1'] };
    try {
      const res = await safeRequest(`http://localhost:${port}/hook`, { body: '{}' }, policy);
      expect(res.status).toBe(200);
      expect(res.body).toBe('ok POST');
      const fetched = await egressFetch(policy)(`http://localhost:${port}/fetch`);
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe('ok GET');
    } finally {
      setDefaultAutoSelectFamily(previous);
      srv.close();
    }
  });
});

// #238: an IPv6 address can embed an IPv4 address in several forms; the IPv4 block list must
// apply to the embedded address, at the URL check and at the connect-time DNS check.
describe('IPv4 addresses embedded in IPv6', () => {
  const blockedLiterals = [
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped, dotted (normalised by URL to hex)
    'http://[::ffff:7f00:1]/', // IPv4-mapped, hex
    'http://[::ffff:169.254.169.254]/', // cloud metadata, mapped
    'http://[::7f00:1]/', // IPv4-compatible
    'http://[64:ff9b::7f00:1]/', // NAT64
    'http://[64:ff9b::a9fe:a9fe]/', // NAT64 of cloud metadata
    'http://[2002:7f00:1::]/', // 6to4, embedded address in bits 16-48
    'http://[2002:a9fe:a9fe::1]/', // 6to4 of cloud metadata
  ];

  it('blocks IPv4-mapped, compatible, NAT64 and 6to4 literals in URLs', () => {
    for (const url of blockedLiterals) expect(checkUrl(url, none), url).toContain('private address');
  });

  it('blocks those literal hosts before a request reaches the network', async () => {
    const srv = createServer((_req, res) => res.end('internal-secret'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      await expect(safeRequest(`http://127.0.0.1:${port}/`, {}, none)).rejects.toThrow(/private address/);
      await expect(safeRequest(`http://[::ffff:127.0.0.1]:${port}/`, {}, none)).rejects.toThrow(/private address/);
      await expect(safeRequest(`http://[::ffff:7f00:1]:${port}/`, {}, none)).rejects.toThrow(/private address/);
    } finally {
      srv.close();
    }
  });

  it('blocks an address returned by DNS at connect time in every embedded form', async () => {
    for (const address of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::'])
      await expect(lookupOf(resolving([{ address, family: 6 }]), { all: true }), address).rejects.toThrow(/private address/);
  });

  it('still allows these forms when the embedded address is public', async () => {
    for (const address of ['::ffff:93.184.216.34', '::ffff:5db8:d822', '::5db8:d822', '64:ff9b::5db8:d822', '2002:5db8:d822::'])
      await expect(lookupOf(resolving([{ address, family: 6 }]), { all: true }), address).resolves.toEqual({
        address: [{ address, family: 6 }],
      });
    expect(checkUrl('http://[::ffff:93.184.216.34]/', none)).toBeNull();
  });
});

describe('response bounds', () => {
  const local = { allowedHosts: ['127.0.0.1'] };

  it('rejects an oversized HTTP/1 response as soon as the byte limit is crossed', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      // Ten megabytes: enough that draining the whole body would be noticeable.
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let i = 0; i < 160; i++) res.write(chunk);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const started = Date.now();
    try {
      await expect(safeRequest(`http://127.0.0.1:${port}/`, { maxBytes: 1024, timeoutMs: 5_000 }, local)).rejects.toThrow(
        /exceeds 1024 bytes/,
      );
    } finally {
      expect(Date.now() - started).toBeLessThan(2_000);
      srv.close();
    }
  });

  it('cuts off a response that trickles a byte at a time at the total deadline', async () => {
    const timer: NodeJS.Timeout[] = [];
    let stopped = false;
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const t = setInterval(() => {
        if (stopped) return;
        if (!res.write('x')) return;
      }, 200);
      timer.push(t);
      res.on('close', () => {
        stopped = true;
        clearInterval(t);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const started = Date.now();
    try {
      await expect(safeRequest(`http://127.0.0.1:${port}/`, { timeoutMs: 400 }, local)).rejects.toThrow(/timed out after 400 ms/);
    } finally {
      expect(Date.now() - started).toBeLessThan(1_500);
      stopped = true;
      for (const t of timer) clearInterval(t);
      srv.close();
    }
  });

  function h2Server(handler: (stream: import('node:http2').ServerHttp2Stream) => void) {
    const srv = createHttp2Server();
    srv.on('stream', (stream) => {
      const serverStream = stream as import('node:http2').ServerHttp2Stream;
      serverStream.respond({ ':status': 200 });
      handler(serverStream);
    });
    return srv;
  }

  async function listen2(srv: ReturnType<typeof h2Server>): Promise<number> {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return (srv.address() as AddressInfo).port;
  }

  it('rejects an oversized HTTP/2 response as soon as the byte limit is crossed', async () => {
    const srv = h2Server((stream) => {
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let i = 0; i < 160; i++) stream.write(chunk);
      stream.end();
    });
    const port = await listen2(srv);
    const started = Date.now();
    try {
      await expect(egressHttp2(local)(`http://127.0.0.1:${port}/`, { maxBytes: 1024, timeoutMs: 5_000 })).rejects.toThrow(
        /exceeds 1024 bytes/,
      );
    } finally {
      expect(Date.now() - started).toBeLessThan(2_000);
      srv.close();
    }
  });

  it('cuts off a trickling HTTP/2 response at the total deadline', async () => {
    const srv = h2Server((stream) => {
      const t = setInterval(() => stream.write('x'), 200);
      stream.on('close', () => clearInterval(t));
    });
    const port = await listen2(srv);
    const started = Date.now();
    try {
      await expect(egressHttp2(local)(`http://127.0.0.1:${port}/`, { timeoutMs: 400 })).rejects.toThrow(/timed out after 400 ms/);
    } finally {
      expect(Date.now() - started).toBeLessThan(1_500);
      srv.close();
    }
  });
});

describe('signing', () => {
  it('signs and verifies Standard Webhooks', () => {
    const secret = newWebhookSecret();
    const now = 1_790_000_000_000;
    const h = webhookHeaders(secret, 'msg_1', '{"a":1}', now);
    expect(h['webhook-signature']).toBe(signWebhook(secret, 'msg_1', 1_790_000_000, '{"a":1}'));
    expect(verifyWebhook(secret, h, '{"a":1}', now)).toBe(true);
    expect(verifyWebhook(secret, h, '{"a":2}', now)).toBe(false);
    expect(verifyWebhook(secret, h, '{"a":1}', now + 600_000)).toBe(false);
    expect(verifyWebhook(newWebhookSecret(), h, '{"a":1}', now)).toBe(false);
  });

  it('verifies HMAC signatures in hex and base64, with a prefix', () => {
    const sig = createHmac('sha256', 's').update('body').digest('hex');
    expect(verifyHmac('s', 'body', `sha256=${sig}`, 'hex', 'sha256=')).toBe(true);
    expect(verifyHmac('s', 'body', sig, 'hex', 'sha256=')).toBe(false);
    expect(verifyHmac('s', 'body', createHmac('sha256', 's').update('body').digest('base64'), 'base64')).toBe(true);
    expect(verifyHmac('s', 'body', undefined, 'base64')).toBe(false);
  });
});
