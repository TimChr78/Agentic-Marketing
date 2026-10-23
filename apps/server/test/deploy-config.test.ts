import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The repository root, so this test reads the deployment files an operator sees (no Docker, no network).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFile(join(root, name), 'utf8');

const [compose, buildOverlay, envExample, smoke, readme, dockerfile, dockerignore] = await Promise.all([
  read('docker-compose.yml'),
  read('docker-compose.build.yml'),
  read('.env.example'),
  read('scripts/smoke.sh'),
  read('README.md'),
  read('Dockerfile'),
  read('.dockerignore'),
]);

/** The lines of one service, up to the next two-space service key. */
function service(text: string, name: string): string {
  const marker = `\n  ${name}:`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`service ${name} is missing`);
  const body = text.slice(start + marker.length);
  const next = body.search(/\n {2}[a-z][\w-]*:/m);
  return next < 0 ? body : body.slice(0, next);
}

describe('compose deployment configuration', () => {
  const app = service(compose, 'app');
  const clickhouse = service(compose, 'clickhouse');

  it('runs the published release image by default, never a local build', () => {
    expect(app).toMatch(/image:\s*ghcr\.io\/timchr78\/agentic-marketing:\$\{AM_VERSION:-\d+\.\d+\.\d+\}/);
    expect(app).not.toMatch(/^\s*build:/m);
    expect(compose).not.toMatch(/^\s*build:/m);
  });

  it('publishes the app on AM_PORT', () => {
    expect(app).toMatch(/"\$\{AM_PORT:-3000\}:3000"/);
  });

  it('caps ClickHouse memory with CLICKHOUSE_MEM_LIMIT', () => {
    expect(clickhouse).toMatch(/mem_limit:\s*\$\{CLICKHOUSE_MEM_LIMIT:-2g\}/);
  });
});

describe('source-build overlay', () => {
  const app = service(buildOverlay, 'app');

  it('builds the checkout and tags the local image', () => {
    expect(app).toMatch(/^\s*build:\s*(?:\.|$)/m);
    expect(app).toMatch(/image:\s*\$\{AM_BUILD_IMAGE:-agentic-marketing:local\}/);
  });

  it('documents the command that uses both files', () => {
    expect(buildOverlay).toContain('docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build');
  });
});

describe('.env.example', () => {
  it('documents the compose image, port and ClickHouse memory settings', () => {
    expect(envExample).toMatch(/^AM_VERSION=\d+\.\d+\.\d+$/m);
    expect(envExample).toContain('AM_PORT=3000');
    expect(envExample).toContain('CLICKHOUSE_MEM_LIMIT=2g');
    expect(envExample).toMatch(/^#\s*AM_BUILD_IMAGE=/m);
    expect(envExample).toMatch(/pin|latest/i);
  });
});

describe('smoke test', () => {
  it('always uses the source-build overlay, including logs and down', () => {
    expect(smoke).toContain('-f docker-compose.yml -f docker-compose.build.yml');
    expect(smoke).toMatch(/trap 'dc logs app[\s\S]*dc down -v/);
    expect(smoke).toContain('SMOKE_NO_BUILD');
  });
});

describe('Docker build context', () => {
  it('keeps apps/web available to the image build', () => {
    const ignored = dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(ignored).not.toContain('apps/web');
    expect(ignored).toContain('**/node_modules');
    expect(ignored).toContain('**/dist');
  });

  it('builds the live admin UI and copies it into the runtime image', () => {
    expect(dockerfile).toContain('FROM base AS web');
    expect(dockerfile).toContain('tsconfig.base.json');
    expect(dockerfile).toContain('COPY apps/web ./apps/web');
    expect(dockerfile).toContain('build:live');
    expect(dockerfile).toContain('COPY --from=web /app/apps/web/dist /app/apps/web/dist');
  });
});

describe('README quick start', () => {
  it('pulls the released image by default and documents the source-build overlay', () => {
    expect(readme).not.toContain('docker compose up -d --build');
    expect(readme).toContain('docker compose up -d');
    expect(readme).toContain('docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build');
  });

  it('documents the version, port, memory cap and host-mount caveat', () => {
    expect(readme).toContain('AM_VERSION');
    expect(readme).toContain('AM_PORT');
    expect(readme).toContain('CLICKHOUSE_MEM_LIMIT');
    expect(readme).toMatch(/host director|bind mount|named volumes/i);
    expect(readme).toMatch(/permission|uid/i);
  });
});
