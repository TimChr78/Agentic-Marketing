#!/usr/bin/env node
// Print a multi-platform manifest's exact os/architecture pairs (#521). `verify.sh` compares the
// output line by line, so windows/arm64 can never satisfy a linux/arm64 check.
//
//   node scripts/release/manifest-platforms.mjs manifest.json
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The exact `os/architecture` pairs in a Docker manifest list. */
export function platforms(manifest) {
  return (manifest?.manifests ?? [])
    .map((descriptor) => (descriptor?.platform ? `${descriptor.platform.os}/${descriptor.platform.architecture}` : null))
    .filter(Boolean);
}

/** Expected platforms that the manifest does not carry as an exact pair. */
export function missingPlatforms(manifest, expected = ['linux/amd64', 'linux/arm64']) {
  const present = new Set(platforms(manifest));
  return expected.filter((platform) => !present.has(platform));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for (const platform of platforms(manifest)) console.log(platform);
}
