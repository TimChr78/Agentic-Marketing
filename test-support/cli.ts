import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build the real CLI once per Vitest run instead of letting tsx compile it on every `execFile`.
//
// The bundle is self-contained and written to the local temp directory: the checkout lives on a
// slow mount, and loading a 2 MB external-import bundle from there took 28-50s per process while
// this bundle loads in about 2s. Only resvg stays external (its native `.node` binding cannot be
// bundled); its package scope is symlinked beside the artifact.

const root = fileURLToPath(new URL('..', import.meta.url));
const runId = createHash('sha1').update(root).digest('hex').slice(0, 8);
const outdir = join(tmpdir(), `am-test-cli-${runId}`);
const outfile = join(outdir, 'cli.mjs');

let building: Promise<string> | undefined;

/** The environment variable the server project's global setup uses to share the artifact. */
export const CLI_ENV = 'AM_TEST_CLI';

/** The artifact path; after `buildTestCli()` it is also in `process.env.AM_TEST_CLI`. */
export function testCliPath(): string {
  return process.env[CLI_ENV] ?? outfile;
}

/**
 * Bundles `apps/server/src/cli.ts` once per run (per process when called lazily) and returns the
 * artifact path. Safe to call from global setup and from a test file in the same worker tree.
 */
export function buildTestCli(): Promise<string> {
  if (process.env[CLI_ENV]) return Promise.resolve(process.env[CLI_ENV]!);
  building ??= build().catch((error: unknown) => {
    building = undefined;
    throw error;
  });
  return building;
}

async function build(): Promise<string> {
  const require = createRequire(join(root, 'package.json'));
  const tsxRequire = createRequire(require.resolve('tsx/package.json'));
  const esbuild = (await import(tsxRequire.resolve('esbuild'))) as {
    build: (options: Record<string, unknown>) => Promise<void>;
  };
  const pkg = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8')) as { version: string };

  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, 'node_modules'), { recursive: true });

  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['apps/server/src/cli.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['pg-native', '@resvg/resvg-js'],
    // Bundled CommonJS (pg) calls require() for Node built-ins; in an ES module that needs a
    // module-local require. `import.meta` must stay intact for the paths the ops commands read.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'warning',
    plugins: [
      {
        // version.ts resolves apps/server/package.json relative to its own source; in a bundle that
        // path is wrong, so inline the one value it reads.
        name: 'test-cli-version',
        setup(buildApi: { onLoad: (options: { filter: RegExp }, callback: () => { contents: string; loader: string }) => void }) {
          buildApi.onLoad({ filter: /apps\/server\/src\/version\.ts$/ }, () => ({
            contents: `export const VERSION = ${JSON.stringify(pkg.version)};\nexport const COMMIT = process.env.AM_GIT_SHA || undefined;\n`,
            loader: 'ts',
          }));
        },
      },
    ],
  });

  // resvg is external so Node can load its CommonJS binding and native `.node` file. Link its
  // dependency scope (resvg-js and the platform package) beside the artifact.
  const assetsRequire = createRequire(join(root, 'packages/assets/package.json'));
  const resvg = dirname(dirname(assetsRequire.resolve('@resvg/resvg-js')));
  await symlink(resvg, join(outdir, 'node_modules/@resvg'), 'dir');

  process.env[CLI_ENV] = outfile;
  return outfile;
}
