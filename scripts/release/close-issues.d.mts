/** Types for close-issues.mjs, so the release-tooling tests can import it. */
export function parseCloses(body: string): number[];
export function parseIssuesComment(section: string | null | undefined): number[];
export function releasePullRequests(options: {
  repo: string;
  version: string;
  publishedAt: string;
}): { number: number; body?: string; mergedAt: string }[];
