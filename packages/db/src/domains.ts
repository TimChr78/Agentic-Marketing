import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { Db } from './pool';

// Workspace domains (#186): a hostname, and optionally a path prefix, maps to one workspace. Host
// resolution happens before a workspace is known, so reads use the owner connection, the same
// mechanism as the public archive lookup; the commands that edit the rows still run under RLS.

export type WorkspaceDomainStatus = 'pending' | 'verified';

export interface WorkspaceDomain {
  id: string;
  workspaceId: string;
  host: string;
  pathPrefix: string | null;
  isPrimary: boolean;
  status: WorkspaceDomainStatus;
  verifiedAt: Date | null;
  createdAt: Date;
}

/** A domain that matched a request; `pathPrefix` is the longest prefix that applied. */
export interface ResolvedWorkspaceDomain {
  domain: WorkspaceDomain;
  matchedPrefix: string | null;
}

/** A hostname or path prefix that cannot be registered, with a message a person can act on. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** The origin a registered host serves: https everywhere, plain http only on localhost. */
export function originForHost(host: string): string {
  // A literal IPv6 address needs brackets inside a URL.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${isLoopbackHost(host) ? 'http' : 'https'}://${authority}`;
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface NormalizeHostOptions {
  /**
   * Registration input: refuse an explicit non-default port instead of silently dropping it (#481).
   * Request `Host` headers keep their port stripped, because a proxy may forward `host:port`.
   */
  forRegistration?: boolean;
}

/**
 * Lowercase, IDNA, no port, no trailing dot. A URL is accepted when it carries a scheme, but its
 * path, query and userinfo are refused: those belong in `pathPrefix`, or nowhere.
 */
export function normalizeHost(input: string, options: NormalizeHostOptions = {}): string {
  const raw = input.trim();
  if (!raw) throw new DomainError('Give a hostname, for example links.example.com.');
  if (raw.includes('@')) throw new DomainError('A hostname must not include a username or password.');
  if (raw.includes('*')) throw new DomainError('Wildcard hostnames are not supported; register each hostname.');
  if (raw.includes('?') || raw.includes('#')) throw new DomainError('A hostname must not include a query or fragment.');

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    throw new DomainError(`"${input}" is not a valid hostname.`);
  }
  if (hasScheme) {
    const scheme = url.protocol.replace(':', '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') throw new DomainError('Use an https URL (or http on localhost) for a brand domain.');
  }
  if (url.username || url.password) throw new DomainError('A hostname must not include a username or password.');
  if (url.search || url.hash) throw new DomainError('A hostname must not include a query or fragment.');
  if (url.pathname && url.pathname !== '/')
    throw new DomainError('Put a path in pathPrefix, not in the hostname; the hostname is just the domain.');

  if (options.forRegistration && url.port) {
    // #481: a port used to be dropped silently, so the stored host, the links and the verification
    // fetch all used the default port. Refuse it instead of changing what the caller asked for.
    const defaultPort = hasScheme ? (url.protocol === 'https:' ? '443' : '80') : '443';
    if (url.port !== defaultPort)
      throw new DomainError(
        'A brand domain is a hostname without a port; links use https on 443 (plain http only on localhost). Remove the port and point that hostname at this installation.',
      );
  }

  // URL already converts IDNs to punycode and separates the port; strip a trailing root dot.
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new DomainError(`"${input}" is not a valid hostname.`);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (isIP(host)) {
    // A literal address has no scheme of its own; only loopback may use plain http.
    if (hasScheme && url.protocol === 'http:' && !isLoopbackHost(host))
      throw new DomainError('Use https for a public host; plain http is allowed only on localhost.');
    return host;
  }

  const ascii = domainToASCII(host).replace(/\.$/, '').toLowerCase();
  if (!ascii) throw new DomainError(`"${input}" is not a valid hostname.`);
  if (ascii.length > 253) throw new DomainError('A hostname must be 253 characters or fewer.');
  const labels = ascii.split('.');
  if (!labels.length || labels.some((label) => !HOST_LABEL.test(label))) throw new DomainError(`"${input}" is not a valid hostname.`);
  if (hasScheme && url.protocol === 'http:' && !isLoopbackHost(ascii))
    throw new DomainError('Use https for a public host; plain http is allowed only on localhost.');
  return ascii;
}

const PATH_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/;

/**
 * `/am/` → `/am`, `am` → `/am`; an empty value or `/` means the whole host. Segments may not be
 * empty, `.` or `..`, and backslashes, queries and fragments are refused rather than guessed at.
 */
export function normalizePathPrefix(input?: string | null): string | null {
  if (input === undefined || input === null) return null;
  let value = input.trim();
  if (!value || value === '/') return null;
  if (value.includes('\\')) throw new DomainError('A path prefix uses forward slashes.');
  if (value.includes('?') || value.includes('#')) throw new DomainError('A path prefix must not include a query or fragment.');
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/{2,}/g, '/');
  // A loop, not /\/+$/, so a long run of slashes cannot make the match polynomial (CodeQL).
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  const segments = value.slice(1).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'))
    throw new DomainError('A path prefix may not contain empty, "." or ".." segments.');
  if (!segments.every((segment) => PATH_SEGMENT.test(segment)))
    throw new DomainError('A path prefix may contain letters, digits and URL path punctuation only.');
  return value;
}

export function normalizeDomainInput(input: { host: string; pathPrefix?: string | null }): {
  host: string;
  pathPrefix: string | null;
} {
  return { host: normalizeHost(input.host, { forRegistration: true }), pathPrefix: normalizePathPrefix(input.pathPrefix) };
}

/** A request path as it is matched: leading slash, no query or fragment. */
export function normalizeRequestPath(path: string): string {
  let value = path.split(/[?#]/, 1)[0] ?? '';
  if (!value.startsWith('/')) value = `/${value}`;
  return value || '/';
}

/** True when `path` is `prefix` itself or sits below it. A null prefix matches every path. */
export function pathMatchesPrefix(path: string, prefix: string | null): boolean {
  if (prefix === null) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export interface DomainResolverOptions {
  /** How long cached rows may be reused. Writes also invalidate the cache explicitly. */
  ttlMs?: number;
  now?: () => number;
}

export interface WorkspaceDomainResolver {
  /** The workspace (and longest matching prefix) for a Host header and request path, or null. */
  resolveWorkspaceForRequest(host: string, path: string): Promise<ResolvedWorkspaceDomain | null>;
  /** The origin+prefix a workspace's primary domain serves, or null when it has no primary. */
  linksUrlFor(workspaceId: string): Promise<string | null>;
  /**
   * Whether public routes check the Host. This is installation policy, not derived from the current
   * rows: once a brand domain has been verified it stays on, even if that domain is removed (#463).
   */
  hostCheckingActive(): Promise<boolean>;
  /**
   * Persist that Host checking is on, so removing the last verified domain cannot switch it off
   * (#463). Called when a verification succeeds.
   */
  activateHostChecking(): Promise<void>;
  /**
   * Drop cached rows after a write; the next lookup reads the table again. Other processes converge
   * within the cache TTL (5 s by default), which is the documented cross-process bound (#464).
   */
  invalidate(): void;
}

const DOMAIN_COLUMNS = `id, workspace_id AS "workspaceId", host, path_prefix AS "pathPrefix",
  is_primary AS "isPrimary", status, verified_at AS "verifiedAt", created_at AS "createdAt"`;

const DOMAIN_ROUTING_KEY = 'domain_routing_active';

interface DomainRegistry {
  rows: WorkspaceDomain[];
  active: boolean;
}

/**
 * Reads every registered domain once and answers lookups from a short-lived cache. The table is
 * small (a handful of brands per installation), so one query is cheaper than a query per request.
 *
 * The cache is per process. Writes invalidate it in the process that ran the command; every other
 * process (api, ingest, worker, replicas) sees the change after at most the TTL (#464).
 */
export function createWorkspaceDomainResolver(db: Db, options: DomainResolverOptions = {}): WorkspaceDomainResolver {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? Date.now;
  let cache: { at: number; registry: DomainRegistry } | null = null;
  let loading: Promise<DomainRegistry> | null = null;
  // A write bumps the generation. A load that started before it must not repopulate the cache with
  // rows read before the write (#464).
  let generation = 0;

  const load = async (): Promise<DomainRegistry> => {
    if (cache && now() - cache.at < ttlMs) return cache.registry;
    if (loading) return loading;
    const startedAt = generation;
    const run = Promise.all([
      db.admin.query<WorkspaceDomain>(`SELECT ${DOMAIN_COLUMNS} FROM workspace_domains`),
      db.admin.query<{ key: string }>('SELECT key FROM installation_settings WHERE key = $1', [DOMAIN_ROUTING_KEY]),
    ]).then(([domains, setting]) => {
      const rows = domains.rows;
      // A verified row also activates checking, so an installation upgraded from 0.8–0.10 whose
      // setting is not backfilled yet behaves exactly as before until the next verification.
      const registry = { rows, active: setting.rows.length > 0 || rows.some((row) => row.status === 'verified') };
      if (startedAt === generation) cache = { at: now(), registry };
      return registry;
    });
    loading = run;
    run
      .finally(() => {
        if (loading === run) loading = null;
      })
      .catch(() => {
        // The caller sees the original rejection; this only settles the cleanup chain.
      });
    return run;
  };

  return {
    async resolveWorkspaceForRequest(host, path) {
      let normalizedHost: string;
      try {
        normalizedHost = normalizeHost(host);
      } catch {
        return null;
      }
      const requestPath = normalizeRequestPath(path);
      // Only a verified domain serves traffic (#185): a pending row is listed for the operator but
      // is not yet a brand host, so it can never take over another workspace's links.
      const matches = (await load()).rows
        .filter((row) => row.status === 'verified' && row.host === normalizedHost && pathMatchesPrefix(requestPath, row.pathPrefix))
        .sort((a, b) => (b.pathPrefix?.length ?? 0) - (a.pathPrefix?.length ?? 0));
      const domain = matches[0];
      return domain ? { domain, matchedPrefix: domain.pathPrefix } : null;
    },
    async linksUrlFor(workspaceId) {
      const domain = (await load()).rows.find((row) => row.workspaceId === workspaceId && row.isPrimary && row.status === 'verified');
      return domain ? `${originForHost(domain.host)}${domain.pathPrefix ?? ''}` : null;
    },
    async hostCheckingActive() {
      return (await load()).active;
    },
    async activateHostChecking() {
      await db.admin.query(
        `INSERT INTO installation_settings (key, value) VALUES ($1, '{"active": true}'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [DOMAIN_ROUTING_KEY],
      );
      generation += 1;
      cache = null;
      loading = null;
    },
    invalidate() {
      generation += 1;
      cache = null;
      // A request that already started keeps its own answer, but the next one loads fresh.
      loading = null;
    },
  };
}
