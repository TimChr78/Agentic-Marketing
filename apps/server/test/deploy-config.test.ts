import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The repository root, so this test reads the deployment files an operator sees (no Docker, no network).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFile(join(root, name), 'utf8');

const [compose, composeOverride, composeDoc, buildOverlay, envExample, smoke, readme, dockerfile, dockerignore, ci] = await Promise.all([
  read('docker-compose.yml'),
  read('compose.override.example.yaml'),
  read('docs/deployment/compose.md'),
  read('docker-compose.build.yml'),
  read('.env.example'),
  read('scripts/smoke.sh'),
  read('README.md'),
  read('Dockerfile'),
  read('.dockerignore'),
  read('.github/workflows/ci.yml'),
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

/** The top-level service keys, i.e. the two-space keys under `services:`. */
function serviceNames(text: string): string[] {
  const start = text.indexOf('\nservices:');
  if (start < 0) throw new Error('services section is missing');
  const rest = text.slice(start + '\nservices:'.length);
  const end = rest.search(/^\S/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  return [...body.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((match) => match[1]);
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

describe('compose production defaults', () => {
  it('restarts every service unless stopped', () => {
    const names = serviceNames(compose);
    expect(names).toEqual(expect.arrayContaining(['postgres', 'clickhouse', 'nats', 'valkey', 'app']));
    for (const name of names) {
      expect(service(compose, name)).toMatch(/^ {4}restart: unless-stopped$/m);
    }
  });

  it('health-checks NATS on its monitoring endpoint and Valkey through the CLI', () => {
    const nats = service(compose, 'nats');
    expect(nats).toContain('image: nats:2.15.0-alpine');
    expect(nats).toContain('"-m", "8222"');
    expect(nats).toMatch(/healthz\?js-enabled-only=true/);
    expect(nats).toMatch(/interval: 5s[\s\S]*retries: 20/);
    const valkey = service(compose, 'valkey');
    expect(valkey).toContain('valkey-cli ping');
    expect(valkey).toMatch(/interval: 5s[\s\S]*retries: 10/);
  });

  it('waits for NATS and Valkey to be healthy', () => {
    const app = service(compose, 'app');
    expect(app).toMatch(/nats:\n\s+condition: service_healthy/);
    expect(app).toMatch(/valkey:\n\s+condition: service_healthy/);
  });

  it('publishes the public listener from PUBLIC_BIND without edits', () => {
    const app = service(compose, 'app');
    expect(app).toMatch(/PUBLIC_PORT: \$\{PUBLIC_PORT:-\}/);
    expect(app).toMatch(/"\$\{PUBLIC_BIND:-127\.0\.0\.1:3001\}:\$\{PUBLIC_PORT:-3001\}"/);
    const mapping = app.split('\n').find((line) => line.includes('PUBLIC_BIND') && line.trim().startsWith('-'));
    expect(mapping).toBeTruthy();
    expect(mapping).not.toContain('#');
  });

  it('forbids editing the release file and points at the override', () => {
    expect(compose).toMatch(/Never edit this file/i);
    expect(compose).toContain('compose.override.yaml');
  });
});

describe('compose override example', () => {
  it('keeps every example commented, so copying it changes nothing', () => {
    const uncommented = composeOverride.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
    expect(uncommented).toEqual([]);
  });

  it('shows an external network, bind mounts, limits and the scheduled backup service', () => {
    expect(composeOverride).toMatch(/external:\s*true/);
    expect(composeOverride).toMatch(/tunnel container/i);
    expect(composeOverride).toContain('/srv/am/pgdata:/var/lib/postgresql/data');
    expect(composeOverride).toContain('/srv/am/clickhouse:/var/lib/clickhouse');
    expect(composeOverride).toContain('/srv/am/nats:/data');
    expect(composeOverride).toMatch(/mem_limit:/);
    expect(composeOverride).toMatch(/#\s+command: \["am", "backup", "--schedule"/);
  });
});

describe('compose documentation', () => {
  it('documents install, the never-edit rule and the upgrade commands', () => {
    expect(composeDoc).toContain('Never edit docker-compose.yml');
    expect(composeDoc).toContain('compose.override.yaml');
    expect(composeDoc).toContain('docker compose pull');
    expect(composeDoc).toContain('docker compose up -d');
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

  it('documents the public listener bind address', () => {
    expect(envExample).toMatch(/^# PUBLIC_BIND=127\.0\.0\.1:3001$/m);
    expect(envExample).toMatch(/PUBLIC_BIND[\s\S]{0,300}(tunnel|network)/i);
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

describe('CI Node version', () => {
  it('matches the Docker image major, so the egress lookup test runs on the shipped Node', () => {
    // Node 20+ defaults autoSelectFamily to true; the egress lookup test asserts that behaviour.
    const image = /^FROM\s+node:(\d+)-/m.exec(dockerfile)?.[1];
    const workflow = /node-version:\s*["']?(\d+)/.exec(ci)?.[1];
    expect(image).toBeTruthy();
    expect(workflow).toBe(image);
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
