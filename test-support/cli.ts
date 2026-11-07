import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Build the real CLI once per Vitest run instead of letting tsx compile it on every `execFile`.
//
// The bundle is self-contained and written to the local temp directory: the checkout lives on a
// slow mount, and loading a 2 MB external-import bundle from there took 28-50s per process while
// this bundle loads in about 2s. Only resvg stays external (its native `.node` binding cannot be
// bundled); its package scope is symlinked beside the artifact.
//
// The directory carries a run-unique id (#518): two runs on the same checkout (or one run's global
// setup and a stray worker) must never delete an artifact another is still using. `AM_TEST_RUN`
// names the run explicitly; otherwise it is the pid plus random bytes.

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = root.endsWith('/') ? root : `${root}/`;

interface BuildApi {
  onLoad(
    options: { filter: RegExp },
    callback: (args: {
      path: string;
    }) => { contents: string; loader: string } | undefined | Promise<{ contents: string; loader: string } | undefined>,
  ): void;
}

/** The environment variable the server project's global setup uses to share the artifact. */
export const CLI_ENV = 'AM_TEST_CLI';

/** Optional run id; when absent, a pid and random suffix keep concurrent runs apart. */
export const RUN_ENV = 'AM_TEST_RUN';

const sanitize = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '_') || 'run';

/**
 * The id shared by this run's processes. Global setup calls it before workers start, so teardown
 * and workers agree even though each process could otherwise generate its own value.
 */
export function ensureTestRunId(): string {
  const fromEnvironment = process.env[RUN_ENV]?.trim();
  if (fromEnvironment) return sanitize(fromEnvironment);
  process.env[RUN_ENV] ??= `${process.pid}-${randomBytes(6).toString('hex')}`;
  return sanitize(process.env[RUN_ENV]);
}

/** The directory that holds this run's artifact. */
export function testCliDir(runId: string = ensureTestRunId()): string {
  return join(tmpdir(), `am-test-cli-${sanitize(runId)}`);
}

/** The artifact path; after `buildTestCli()` it is also in `process.env.AM_TEST_CLI`. */
export function testCliPath(): string {
  return process.env[CLI_ENV] ?? join(testCliDir(), 'cli.mjs');
}

const building = new Map<string, Promise<string>>();

/**
 * Bundles `apps/server/src/cli.ts` once per run id (per process when called lazily) and returns the
 * artifact path. Safe to call from global setup and from a test file in the same worker tree.
 * Passing a run id explicitly bypasses `AM_TEST_CLI`, which is what tests of the builder itself do.
 */
export function buildTestCli(runId?: string): Promise<string> {
  if (runId === undefined && process.env[CLI_ENV]) return Promise.resolve(process.env[CLI_ENV]);
  const id = sanitize(runId ?? ensureTestRunId());
  let pending = building.get(id);
  if (!pending) {
    pending = build(id).catch((error: unknown) => {
      building.delete(id);
      throw error;
    });
    building.set(id, pending);
  }
  return pending.then((path) => {
    if (runId === undefined && !process.env[CLI_ENV]) process.env[CLI_ENV] = path;
    return path;
  });
}

/** Removes this run's artifact. Global teardown calls it with no argument, after workers exit. */
export async function cleanupTestCli(runId?: string): Promise<void> {
  const id = sanitize(runId ?? ensureTestRunId());
  const dir = testCliDir(id);
  await rm(dir, { recursive: true, force: true });
  building.delete(id);
  if (runId === undefined && process.env[CLI_ENV] === join(dir, 'cli.mjs')) delete process.env[CLI_ENV];
}

async function build(runId: string): Promise<string> {
  const require = createRequire(join(root, 'package.json'));
  const tsxRequire = createRequire(require.resolve('tsx/package.json'));
  const esbuild = (await import(tsxRequire.resolve('esbuild'))) as {
    build: (options: Record<string, unknown>) => Promise<void>;
  };
  const pkg = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8')) as { version: string };

  const outdir = testCliDir(runId);
  const outfile = join(outdir, 'cli.mjs');
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
    // module-local require. The banner's `import.meta.url` is the artifact, which is correct for
    // resolving built-ins; every source module gets its own original URL from the plugin below.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'warning',
    plugins: [
      {
        // version.ts resolves apps/server/package.json relative to its own source; in a bundle that
        // path is wrong, so inline the one value it reads.
        name: 'test-cli-version',
        setup(buildApi: BuildApi) {
          buildApi.onLoad({ filter: /apps\/server\/src\/version\.ts$/ }, () => ({
            contents: `export const VERSION = ${JSON.stringify(pkg.version)};\nexport const COMMIT = process.env.AM_GIT_SHA || undefined;\n`,
            loader: 'ts',
          }));
        },
      },
      {
        // esbuild leaves `import.meta.url` pointing at the artifact. Several modules use it to find
        // files beside their source (migrations, .env.example, CHANGELOG.md, recipes, web assets),
        // so rewrite it per module to that module's original file URL. Marking them external would
        // not work: they are TypeScript, and the dynamic ops imports would still resolve here.
        name: 'test-cli-source-urls',
        setup(buildApi: BuildApi) {
          const loaders: Record<string, string> = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js' };
          buildApi.onLoad({ filter: /\.(?:[cm]?[jt]sx?)$/ }, async (args) => {
            if (!args.path.startsWith(sourceRoot) || args.path.includes('/node_modules/')) return undefined;
            const source = await readFile(args.path, 'utf8');
            if (!source.includes('import.meta.url')) return undefined;
            const extension = args.path.slice(args.path.lastIndexOf('.'));
            return {
              contents: source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)),
              loader: loaders[extension] ?? 'js',
            };
          });
        },
      },
    ],
  });

  // resvg is external so Node can load its CommonJS binding and native `.node` file. Link its
  // dependency scope (resvg-js and the platform package) beside the artifact.
  const assetsRequire = createRequire(join(root, 'packages/assets/package.json'));
  const resvg = dirname(dirname(assetsRequire.resolve('@resvg/resvg-js')));
  await symlink(resvg, join(outdir, 'node_modules/@resvg'), 'dir');

  return outfile;
}
