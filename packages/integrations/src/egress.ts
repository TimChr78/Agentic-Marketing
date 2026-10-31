import { type LookupAddress, type LookupOptions, lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { connect as http2Connect } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

// Outbound HTTP for webhooks and connector actions, guarded against SSRF
// (security-and-privacy.md §5): only http(s), no redirects, bounded time and response size, and
// the address is checked when the socket connects, after DNS resolution, so a name cannot point
// at an internal service. Private networks are blocked unless the install allows a host or range
// (a homelab's n8n on the LAN, say) with EGRESS_ALLOWED_HOSTS.

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

export interface EgressPolicy {
  /** Host names, IP addresses or CIDR ranges that may be reached even though they are private. */
  allowedHosts: string[];
}

export class EgressError extends Error {}

function allowList(policy: EgressPolicy) {
  const names = new Set<string>();
  const nets = new BlockList();
  for (const h of policy.allowedHosts.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const [addr, bits] = h.split('/');
    const v = isIP(addr);
    if (v && bits) nets.addSubnet(addr, Number(bits), v === 6 ? 'ipv6' : 'ipv4');
    else if (v) nets.addAddress(addr, v === 6 ? 'ipv6' : 'ipv4');
    else names.add(h);
  }
  return { names, nets };
}

const family = (a: string) => (isIP(a) === 6 ? 'ipv6' : 'ipv4');

/** The eight 16-bit words of an IPv6 address, with a dotted IPv4 tail folded in. */
function ipv6Words(address: string): number[] | null {
  const a = address.split('%')[0].toLowerCase();
  if (isIP(a) !== 6) return null;
  const [left = '', right = ''] = a.split('::');
  const words = (part: string) => {
    if (!part) return [];
    const out: number[] = [];
    for (const word of part.split(':')) {
      if (word.includes('.')) {
        const octets = word.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        const n = Number.parseInt(word, 16);
        if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
        out.push(n);
      }
    }
    return out;
  };
  const l = words(left);
  const r = words(right);
  if (!l || !r) return null;
  const missing = 8 - l.length - r.length;
  if (missing < 0) return null;
  return [...l, ...Array<number>(missing).fill(0), ...r];
}

const ipv4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * The IPv4 address an IPv6 form embeds, or null. IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible
 * (`::/96`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`, the address in bits 16-48) all carry
 * an IPv4 address that must be checked against the IPv4 block list.
 */
function embeddedIpv4(address: string): string | null {
  const w = ipv6Words(address);
  if (!w) return null;
  const zero = (from: number, to: number) => w.slice(from, to).every((n) => n === 0);
  if (zero(0, 5) && w[5] === 0xffff) return ipv4(w[6]!, w[7]!);
  if (zero(0, 6)) return ipv4(w[6]!, w[7]!);
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return ipv4(w[6]!, w[7]!);
  if (w[0] === 0x2002) return ipv4(w[1]!, w[2]!);
  return null;
}

/** Whether an address is private (and not explicitly allowed). */
export function isBlockedAddress(address: string, policy: EgressPolicy): boolean {
  const a = address.trim().replace(/^\[|\]$/g, '');
  const { nets } = allowList(policy);
  if (nets.check(a, family(a))) return false;
  const embedded = isIP(a) === 6 ? embeddedIpv4(a) : null;
  if (embedded !== null) {
    // An allow-listed IPv4 range also covers its mapped/NAT64/6to4 forms.
    if (nets.check(embedded, 'ipv4')) return false;
    return blocked.check(embedded, 'ipv4');
  }
  return blocked.check(a, family(a));
}

/** A URL check without network access, for settings: scheme, credentials and literal private addresses. */
export function checkUrl(raw: string, policy: EgressPolicy): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'only http and https URLs are allowed';
  if (u.username || u.password) return 'credentials in the URL are not allowed; use a secret header';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowList(policy).names.has(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return `${host} is an internal address`;
  if (isIP(host) && isBlockedAddress(host, policy)) return `${host} is a private address; allow it with EGRESS_ALLOWED_HOSTS`;
  return null;
}

export type DnsResolve = (
  hostname: string,
  options: LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const dnsLookup = lookup as unknown as DnsResolve;

/**
 * Resolve, then refuse private addresses unless the name itself is on the allow list. Every
 * address is checked, so a mixed public/private answer cannot slip through. `autoSelectFamily`
 * (the default since Node 20) calls this with `all: true` and expects an array.
 */
export function lookupFor(u: URL, policy: EgressPolicy, resolve: DnsResolve = dnsLookup): LookupFunction {
  const named = allowList(policy).names.has(u.hostname.toLowerCase());
  return (hostname, options, cb) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      if (!addresses.length) {
        const notFound: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        notFound.code = 'ENOTFOUND';
        return cb(notFound, '', 0);
      }
      if (!named) {
        for (const { address } of addresses)
          if (isBlockedAddress(address, policy)) return cb(new EgressError(`${hostname} resolves to private address ${address}`), '', 0);
      }
      if (options.all) return cb(null, addresses);
      cb(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * One HTTP request under the egress policy. Throws EgressError when the target is not allowed.
 *
 * Bounds: `maxBytes` (default 256 KiB) is a reading limit, not a retention limit: the response is
 * aborted as soon as it is crossed. `timeoutMs` (default 10 s) is a total deadline for the whole
 * request, connect, headers and body included, so a server that trickles bytes cannot keep it open.
 */
export function safeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number },
  policy: EgressPolicy,
): Promise<SafeResponse> {
  const problem = checkUrl(url, policy);
  if (problem) return Promise.reject(new EgressError(problem));
  const u = new URL(url);
  const guardedLookup = lookupFor(u, policy);
  const maxBytes = init.maxBytes ?? 256 * 1024;
  const timeoutMs = init.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout;
    const finish = (err: Error | null, value?: SafeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(value!);
    };
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: init.method ?? 'POST',
        // An explicit length: Node does not chunk DELETE bodies, so without it they arrive malformed.
        headers: {
          'user-agent': 'agentic-marketing-webhooks/1',
          ...(init.body !== undefined ? { 'content-length': String(Buffer.byteLength(init.body)) } : {}),
          ...init.headers,
        },
        lookup: guardedLookup,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            // Stop reading at once instead of draining: an endless or oversized body would keep
            // the worker and the connection busy. Destroying the request destroys the response.
            req.destroy();
            finish(new EgressError(`response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')])),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(err));
      },
    );
    deadline = setTimeout(() => {
      req.destroy();
      finish(new EgressError(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    req.on('error', (err) => finish(err));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * A fetch that goes through the egress guard, for code that takes a fetch (e-mail and SMS
 * provider adapters): a provider URL pointing at a private address is refused like a webhook's.
 */
export function egressFetch(policy: EgressPolicy): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const headers = Object.fromEntries(new Headers(req ? req.headers : init?.headers).entries());
    const method = init?.method ?? req?.method ?? 'GET';
    // Binary bodies (gzipped uploads) pass through as bytes; anything else as text.
    const raw = init?.body;
    const body =
      raw !== undefined && raw !== null
        ? raw instanceof Uint8Array || raw instanceof ArrayBuffer
          ? Buffer.from(raw as Uint8Array)
          : String(raw)
        : req && method !== 'GET' && method !== 'HEAD'
          ? Buffer.from(await req.arrayBuffer())
          : undefined;
    const res = await safeRequest(url, { method, headers, body, timeoutMs: 30_000, maxBytes: 1024 * 1024 }, policy);
    return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

export type Http2Request = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number },
) => Promise<SafeResponse>;

/**
 * One HTTP/2 request under the egress policy, for providers that only speak HTTP/2 (Apple's push
 * service). http:// targets use HTTP/2 without TLS (prior knowledge), for test servers.
 *
 * The same bounds as `safeRequest` apply: `maxBytes` (default 256 KiB) aborts the stream as soon
 * as the response crosses it, and `timeoutMs` (default 30 s) is a total deadline for the request.
 */
export function egressHttp2(policy: EgressPolicy): Http2Request {
  return (url, init) => {
    const problem = checkUrl(url, policy);
    if (problem) return Promise.reject(new EgressError(problem));
    const u = new URL(url);
    const timeout = init.timeoutMs ?? 30_000;
    const maxBytes = init.maxBytes ?? 256 * 1024;
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: NodeJS.Timeout;
      const session = http2Connect(u.origin, { lookup: lookupFor(u, policy) });
      const finish = (err: Error | null, value?: SafeResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (err) session.destroy();
        else session.close();
        if (err) reject(err);
        else resolve(value!);
      };
      deadline = setTimeout(() => finish(new EgressError(`timed out after ${timeout} ms`)), timeout);
      session.on('error', (err) => finish(err));
      const req = session.request({ ':method': init.method ?? 'POST', ':path': `${u.pathname}${u.search}`, ...init.headers });
      let status = 0;
      let headers: Record<string, string> = {};
      req.on('response', (h) => {
        status = Number(h[':status']);
        headers = Object.fromEntries(
          Object.entries(h)
            .filter(([k]) => !k.startsWith(':'))
            .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
        );
      });
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          finish(new EgressError(`response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!status) return finish(new Error(`no response within ${timeout} ms`));
        finish(null, { status, headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      req.on('error', (err) => finish(err));
      if (init.body !== undefined) req.end(init.body);
      else req.end();
    });
  };
}
