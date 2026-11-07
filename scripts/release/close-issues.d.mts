/** Types for close-issues.mjs, so the release-tooling tests can import it. */
export function parseCloses(body: string): number[];
export function parseIssuesComment(section: string | null | undefined): number[];
export function selectReleasePullRequests(options: {
  prs: { number: number; body?: string; baseRefName?: string; mergeCommit?: { oid: string } | null }[];
  commits: string[];
  defaultBranch: string;
}): { number: number; body?: string; baseRefName?: string; mergeCommit?: { oid: string } | null }[];
export function issuesForRelease(options: { prs: { number: number; body?: string }[]; changelog: string; version?: string }): number[];
export function readChangelogAtTag(version: string, run?: (args: string[]) => string): string;
export function previousTagFrom(tags: string[], version: string): string | null;
