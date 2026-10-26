import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version';
import { connectAgent, startTestServer, type User } from './harness';

// Issue #120: the running version comes from one file and every surface that names a version reports it.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as { version: string };

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sources(path));
    else if (/\.[cm]?tsx?$/.test(name)) files.push(path);
  }
  return files;
}

describe('the version file', () => {
  it('matches the root package, the server package and the chart', () => {
    expect(json('../../../package.json').version).toBe(VERSION);
    expect(json('../package.json').version).toBe(VERSION);
    const chart = read('../../../deploy/helm/agentic-marketing/Chart.yaml');
    expect(/^appVersion:\s*"?([^"\n]+)"?$/m.exec(chart)?.[1]).toBe(VERSION);
  });

  it('has no hard-coded version left in the server source', () => {
    const dir = fileURLToPath(new URL('../src', import.meta.url));
    const offenders = sources(dir).filter((file) => /version:\s*['"]0\./.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => file.slice(dir.length + 1))).toEqual([]);
  });
});

describe('the running server', () => {
  let t: Awaited<ReturnType<typeof startTestServer>>;
  let owner: User;
  let agent: Awaited<ReturnType<typeof connectAgent>>;

  beforeAll(async () => {
    t = await startTestServer('test_version', 3321);
    owner = await t.signUp(`owner-${Date.now()}@example.com`);
    await t.workspaceWith([[owner, 'owner']]);
    agent = await connectAgent(t.base, owner, ['artifacts:read']);
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  it('reports the version on /healthz and /readyz', async () => {
    for (const path of ['/healthz', '/readyz']) {
      const res = await fetch(`${t.base}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, version: VERSION });
    }
  });

  it('reports the version in the OpenAPI document', async () => {
    const doc = (await (await fetch(`${t.base}/openapi.json`)).json()) as { info: { version: string } };
    expect(doc.info.version).toBe(VERSION);
  });

  it('reports the version in the MCP server info', () => {
    expect(agent.client.getServerVersion()).toMatchObject({ name: 'agentic-marketing', version: VERSION });
  });

  it('reports the version from workspace.get', async () => {
    expect((await t.api(owner).call('workspace.get', {})).serverVersion).toBe(VERSION);
  });
});

describe('migration heads', () => {
  it('maps the newest migration to a release, so backups can name where old data came from', async () => {
    const { latestMigration, releaseForMigrationHead } = await import('@agentic-marketing/db');
    expect(
      releaseForMigrationHead(latestMigration() ?? null),
      `add ${latestMigration()} to MIGRATION_RELEASES in packages/db/src/migrate.ts`,
    ).toBeTruthy();
  });
});
