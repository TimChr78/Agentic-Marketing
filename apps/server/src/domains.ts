import {
  createWorkspaceDomainResolver,
  type Db,
  isLoopbackHost,
  normalizeHost,
  normalizePathPrefix,
  normalizeRequestPath,
  originForHost,
  pathMatchesPrefix,
  type ResolvedWorkspaceDomain,
} from '@agentic-marketing/db';

// Host → workspace resolution for the public listener (#186, #185). The registry is
// installation-wide, so the resolver reads it on the owner connection; the admin API still
// resolves the workspace from the session and X-Workspace-Id.

/** What a public request belongs to, once its Host and path are known (#185). */
export interface PublicRequest {
  /** The matched workspace, or null when the request is on the installation fallback host. */
  workspaceId: string | null;
  /** Origin and path prefix of the host serving this request; links built for it use this base. */
  linksUrl: string;
  /** True when a registered verified domain matched, false on PUBLIC_LINKS_URL. */
  matched: boolean;
  /** The longest matching path prefix, or null when the whole host serves the brand. */
  pathPrefix: string | null;
}

export interface DomainService {
  /** The workspace (and longest matching prefix) a Host header and path belong to, or null. */
  resolveWorkspaceForRequest(host: string, path: string): Promise<ResolvedWorkspaceDomain | null>;
  /**
   * The brand context of a public request: a verified registered host, else the installation
   * fallback host (PUBLIC_LINKS_URL), else null for an unknown host, which the listener answers 404.
   */
  resolvePublicRequest(host: string, path: string): Promise<PublicRequest | null>;
  /** A workspace's verified primary brand origin+prefix, else the installation's PUBLIC_LINKS_URL. */
  linksUrlFor(workspaceId: string): Promise<string>;
  /** Forget cached domains after a command changed them. */
  invalidate(): void;
}

export function createDomainService(db: Db, fallbackLinksUrl: string): DomainService {
  const resolver = createWorkspaceDomainResolver(db);
  // The fallback keeps today's behaviour exactly: its host, and its path prefix when it has one.
  let fallback: { host: string; prefix: string | null } | null = null;
  try {
    const url = new URL(fallbackLinksUrl);
    fallback = { host: normalizeHost(url.hostname), prefix: normalizePathPrefix(url.pathname) };
  } catch {
    fallback = null;
  }

  return {
    resolveWorkspaceForRequest: (host, path) => resolver.resolveWorkspaceForRequest(host, path),
    async resolvePublicRequest(host, path) {
      const resolved = await resolver.resolveWorkspaceForRequest(host, path);
      if (resolved) {
        let normalized: string;
        try {
          normalized = normalizeHost(host);
        } catch {
          return null;
        }
        return {
          workspaceId: resolved.domain.workspaceId,
          linksUrl: `${originForHost(normalized)}${resolved.matchedPrefix ?? ''}`,
          matched: true,
          pathPrefix: resolved.matchedPrefix,
        };
      }
      // No registered match: only the installation's fallback host is still served. Any other
      // Host is not a brand and must not reach another brand's pages. An installation without a
      // verified brand domain keeps its old behaviour and serves public paths on any Host, so an
      // upgrade does not break a proxy that rewrites Host or a LAN address used for testing.
      if (!(await resolver.hasVerifiedDomains()))
        return { workspaceId: null, linksUrl: fallbackLinksUrl, matched: false, pathPrefix: fallback?.prefix ?? null };
      if (!fallback) return null;
      let normalized: string;
      try {
        normalized = normalizeHost(host);
      } catch {
        return null;
      }
      if (normalized !== fallback.host && !(isLoopbackHost(normalized) && isLoopbackHost(fallback.host))) return null;
      if (!pathMatchesPrefix(normalizeRequestPath(path), fallback.prefix)) return null;
      return { workspaceId: null, linksUrl: fallbackLinksUrl, matched: false, pathPrefix: fallback.prefix };
    },
    linksUrlFor: async (workspaceId) => (await resolver.linksUrlFor(workspaceId)) ?? fallbackLinksUrl,
    invalidate: () => resolver.invalidate(),
  };
}
