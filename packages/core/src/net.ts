import { BlockList, isIP } from 'node:net';

/**
 * Header the server sets after it has resolved the client IP itself. Better Auth trusts only this
 * one, so a caller cannot choose its own rate-limit bucket by sending a forwarding header.
 */
export const RESOLVED_CLIENT_IP_HEADER = 'x-am-client-ip';

/** Trims an address and turns the usual transport spellings (brackets, zone, IPv4-mapped IPv6) into a plain IP. */
export function normalizeIp(address: string | undefined | null): string | undefined {
  if (!address) return undefined;
  let value = address.trim();
  if (!value) return undefined;
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  value = value.trim();
  return isIP(value) ? value : undefined;
}

/** Whether a setting is one IP address or one CIDR range, IPv4 or IPv6. */
export function isIpOrCidr(value: string): boolean {
  const entry = value.trim();
  if (!entry) return false;
  if (isIP(entry)) return true;
  const slash = entry.lastIndexOf('/');
  if (slash <= 0 || slash === entry.length - 1) return false;
  const address = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  if (!/^(0|[1-9]\d{0,2})$/.test(prefix)) return false;
  const family = isIP(address);
  const bits = Number(prefix);
  if (family === 4) return bits <= 32;
  if (family === 6) return bits <= 128;
  return false;
}

/** The socket address as the Hono Node adapter exposes it (older and newer shapes). */
export function remoteAddressFromEnv(env: unknown): string | undefined {
  const e = env as
    | { incoming?: { socket?: { remoteAddress?: string } }; server?: { incoming?: { socket?: { remoteAddress?: string } } } }
    | undefined;
  return e?.incoming?.socket?.remoteAddress ?? e?.server?.incoming?.socket?.remoteAddress;
}

export interface ClientIpRequest {
  header: (name: string) => string | undefined;
  remoteAddress?: string;
  /** Header names in trust order, e.g. ['cf-connecting-ip', 'x-forwarded-for']. */
  headerNames: string[];
  /** When set, forwarding headers from any other remote address are ignored. */
  trustedProxyCidrs?: string[];
}

/** A proxy list: bare IPs become addresses, entries with "/" become subnets. Invalid entries are ignored. */
function proxyList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const raw of cidrs) {
    const entry = raw.trim();
    if (!entry) continue;
    const slash = entry.lastIndexOf('/');
    try {
      if (slash > 0) {
        const address = entry.slice(0, slash);
        const family = isIP(address);
        const prefix = Number(entry.slice(slash + 1));
        if (!Number.isInteger(prefix)) continue;
        if (family === 4 && prefix >= 0 && prefix <= 32) list.addSubnet(address, prefix, 'ipv4');
        else if (family === 6 && prefix >= 0 && prefix <= 128) list.addSubnet(address, prefix, 'ipv6');
      } else {
        const family = isIP(entry);
        if (family === 4) list.addAddress(entry, 'ipv4');
        else if (family === 6) list.addAddress(entry, 'ipv6');
      }
    } catch {
      // A malformed entry must not break request handling.
    }
  }
  return list;
}

/**
 * The client IP for rate limits. When the request came through a trusted proxy, walk each
 * forwarding header from right to left and return the first address outside the trusted proxy
 * ranges: that is the client as seen by the outermost trusted proxy. A proxy that appends to an
 * existing header (nginx's default `proxy_add_x_forwarded_for`) leaves client-supplied values on
 * the left, so the leftmost address is not trustworthy. If every address is trusted, use the
 * leftmost. With no proxy list configured (backward compatibility) the leftmost value is used; when
 * the socket peer is not a trusted proxy the header is ignored. Never returns a value that is not
 * an IP address.
 */
export function resolveClientIp(req: ClientIpRequest): string | undefined {
  const remote = normalizeIp(req.remoteAddress);
  const trusted = req.trustedProxyCidrs ?? [];
  const list = trusted.length ? proxyList(trusted) : undefined;
  const family = remote ? isIP(remote) : 0;
  const proxyTrusted = !list || (remote !== undefined && list.check(remote, family === 6 ? 'ipv6' : 'ipv4'));

  if (!proxyTrusted) return remote;

  const isTrusted = (ip: string): boolean => {
    if (!list) return false;
    const ipFamily = isIP(ip);
    return list.check(ip, ipFamily === 6 ? 'ipv6' : 'ipv4');
  };

  for (const name of req.headerNames) {
    const value = req.header(name);
    if (!value) continue;
    const addresses = value
      .split(',')
      .map((entry) => normalizeIp(entry))
      .filter((entry): entry is string => entry !== undefined);
    if (addresses.length === 0) continue;
    if (!list) return addresses[0];
    for (let index = addresses.length - 1; index >= 0; index -= 1) {
      const ip = addresses[index];
      if (!isTrusted(ip)) return ip;
    }
    return addresses[0];
  }
  return remote;
}
