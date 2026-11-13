/** Types for check-notes.mjs, so the release-tooling tests can import it. */
export function topReleaseVersion(changelog: string): string | null;
export function releaseNotesErrors(options: { changelog: string; version?: string | null; status?: string | null }): string[];
