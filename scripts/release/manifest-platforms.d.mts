/** Types for manifest-platforms.mjs, so the release-tooling tests can import it. */
export function platforms(manifest: { manifests?: { platform?: { os?: string; architecture?: string } }[] }): string[];
export function missingPlatforms(
  manifest: { manifests?: { platform?: { os?: string; architecture?: string } }[] },
  expected?: string[],
): string[];
