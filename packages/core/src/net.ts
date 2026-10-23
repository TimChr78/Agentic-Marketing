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
 * The client IP for rate limits: the first valid forwarded header when the request came through a
 * trusted proxy (or when no proxy list is configured, for backward compatibility), else the socket
 * address. Never returns a value that is not an IP address.
 */
export function resolveClientIp(req: ClientIpRequest): string | undefined {
  const remote = normalizeIp(req.remoteAddress);
  const trusted = req.trustedProxyCidrs ?? [];
  const family = remote ? isIP(remote) : 0;
  const proxyTrusted = trusted.length === 0 || (remote !== undefined && proxyList(trusted).check(remote, family === 6 ? 'ipv6' : 'ipv4'));

  if (proxyTrusted) {
    for (const name of req.headerNames) {
      const value = req.header(name);
      if (!value) continue;
      const first = value.split(',')[0]?.trim();
      const ip = normalizeIp(first);
      if (ip) return ip;
    }
  }
  return remote;
}
