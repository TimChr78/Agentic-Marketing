/** Types for release-assets.mjs, so the release-tooling tests can import it. */
export function expectedAssets(version: string): string[];
export function assetProblems(options: { version: string; files: string[]; sums: string }): string[];
