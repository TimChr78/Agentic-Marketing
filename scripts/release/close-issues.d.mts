/** Types for close-issues.mjs, so the release-tooling tests can import it. */
export function parseCloses(body: string): number[];
export function parseIssuesComment(section: string | null | undefined): number[];
export const PR_LIST_LIMIT: number;
export function prLimitWarning(count: number): string | null;
export function localTags(run?: (args: string[]) => string): string[];
export function resolvePreviousTag(options: {
  tags: string[];
  version: string;
  changelog?: string | null;
  explicit?: string | null;
}): string | null;
export function selectReleasePullRequests(options: {
  prs: { number: number; body?: string; baseRefName?: string; mergeCommit?: { oid: string } | null }[];
  commits: string[];
  defaultBranch: string;
}): { number: number; body?: string; baseRefName?: string; mergeCommit?: { oid: string } | null }[];
export function issuesForRelease(options: { prs: { number: number; body?: string }[]; changelog: string; version?: string }): number[];
export function readChangelogAtTag(version: string, run?: (args: string[]) => string): string;
export function previousTagFrom(tags: string[], version: string): string | null;
export function commitsInRange(root: string, previous: string | null, version: string): string[];
