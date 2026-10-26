import { createRequire } from 'node:module';

// The one running version: apps/server/package.json is shipped in the image (/app/apps/server),
// so this reads the same file under tsx in the repo and in the container.
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION = pkg.version;

/** The commit the image was built from; set by the release workflow, absent in a local run. */
export const COMMIT = process.env.AM_GIT_SHA || undefined;
