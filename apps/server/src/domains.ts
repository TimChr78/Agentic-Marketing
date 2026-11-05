import { createWorkspaceDomainResolver, type Db, type ResolvedWorkspaceDomain } from '@agentic-marketing/db';

// Host → workspace resolution for the public listener (#186). The registry is installation-wide,
// so the resolver reads it on the owner connection; the admin API still resolves the workspace
// from the session and X-Workspace-Id.

export interface DomainService {
  /** The workspace (and longest matching prefix) a Host header and path belong to, or null. */
  resolveWorkspaceForRequest(host: string, path: string): Promise<ResolvedWorkspaceDomain | null>;
  /** A workspace's primary brand origin+prefix, else the installation's PUBLIC_LINKS_URL. */
  linksUrlFor(workspaceId: string): Promise<string>;
  /** Forget cached domains after a command changed them. */
  invalidate(): void;
}

export function createDomainService(db: Db, fallbackLinksUrl: string): DomainService {
  const resolver = createWorkspaceDomainResolver(db);
  return {
    resolveWorkspaceForRequest: (host, path) => resolver.resolveWorkspaceForRequest(host, path),
    linksUrlFor: async (workspaceId) => (await resolver.linksUrlFor(workspaceId)) ?? fallbackLinksUrl,
    invalidate: () => resolver.invalidate(),
  };
}
