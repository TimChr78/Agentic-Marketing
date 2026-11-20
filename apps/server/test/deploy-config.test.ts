import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../src/config';
import { scanServerSources } from './env-reads';

// The repository root, so this test reads the deployment files an operator sees (no Docker, no network).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFile(join(root, name), 'utf8');

const [
  compose,
  composeOverride,
  composeDoc,
  composeTest,
  buildOverlay,
  envExample,
  smoke,
  readme,
  dockerfile,
  dockerignore,
  ci,
  helmValues,
  helmIngress,
  kubeDoc,
] = await Promise.all([
  read('docker-compose.yml'),
  read('compose.override.example.yaml'),
  read('docs/deployment/compose.md'),
  read('docker-compose.test.yml'),
  read('docker-compose.build.yml'),
  read('.env.example'),
  read('scripts/smoke.sh'),
  read('README.md'),
  read('Dockerfile'),
  read('.dockerignore'),
  read('.github/workflows/ci.yml'),
  read('deploy/helm/agentic-marketing/values.yaml'),
  read('deploy/helm/agentic-marketing/templates/ingress.yaml'),
  read('docs/deployment/kubernetes.md'),
]);

const [helmDeployments, helmMigrateJob, helmNotes, helmHelpers, helmHpa, helmConfigMap, helmServices] = await Promise.all([
  read('deploy/helm/agentic-marketing/templates/deployments.yaml'),
  read('deploy/helm/agentic-marketing/templates/migrate-job.yaml'),
  read('deploy/helm/agentic-marketing/templates/NOTES.txt'),
  read('deploy/helm/agentic-marketing/templates/_helpers.tpl'),
  read('deploy/helm/agentic-marketing/templates/hpa.yaml'),
  read('deploy/helm/agentic-marketing/templates/configmap.yaml'),
  read('deploy/helm/agentic-marketing/templates/services.yaml'),
]);

/** Environment-file keys, including commented examples (`# KEY=value`). */
function envFileKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw.trim());
    if (match) keys.push(match[1]);
  }
  return keys;
}

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

/** One top-level block of values.yaml, up to the next line that starts at column 0. */
function helmSection(text: string, name: string): string {
  const marker = `\n${name}:\n`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`values.yaml has no ${name} block`);
  const body = text.slice(start + marker.length);
  const end = body.search(/\n(?=\S)/);
  return end < 0 ? body : body.slice(0, end);
}

describe('compose deployment configuration', () => {
  const app = service(compose, 'app');
  const clickhouse = service(compose, 'clickhouse');

  it('runs the published release image by default, never a local build', () => {
    expect(app).toMatch(/image:\s*ghcr\.io\/timchr78\/agentic-marketing:\$\{AM_VERSION:-\d+\.\d+\.\d+\}/);
    expect(app).not.toMatch(/^\s*build:/m);
    expect(compose).not.toMatch(/^\s*build:/m);
  });

  it('publishes the admin port on AM_BIND, loopback only by default (#870)', () => {
    // The public listener beside it is already loopback-only; the admin UI, auth and API must not
    // be reachable from every network the host is on just because the template was copied.
    expect(app).toMatch(/"\$\{AM_BIND:-127\.0\.0\.1\}:\$\{AM_PORT:-3000\}:3000"/);
    const mapping = app.split('\n').find((line) => line.includes('AM_PORT') && line.trim().startsWith('-'));
    expect(mapping).toBeTruthy();
    expect(mapping).not.toContain('#');
  });

  it('caps ClickHouse memory with CLICKHOUSE_MEM_LIMIT', () => {
    expect(clickhouse).toMatch(/mem_limit:\s*\$\{CLICKHOUSE_MEM_LIMIT:-2g\}/);
  });
});

describe('compose production defaults', () => {
  it('restarts every service unless stopped', () => {
    const names = serviceNames(compose);
    expect(names).toEqual(expect.arrayContaining(['postgres', 'clickhouse', 'nats', 'valkey', 'app']));
    // postgres-check is a one-shot guard (#1001): it must run once and exit, never restart.
    const oneShot = new Set(['postgres-check']);
    for (const name of names) {
      expect(service(compose, name)).toMatch(oneShot.has(name) ? /^ {4}restart: "no"$/m : /^ {4}restart: unless-stopped$/m);
    }
  });

  it('guards the PostgreSQL volume against a major-version mismatch (#1001)', () => {
    const postgres = service(compose, 'postgres');
    const guard = service(compose, 'postgres-check');
    // A pulled 16 volume must fail with guidance, not start an empty 18 cluster beside it.
    expect(postgres).toMatch(/depends_on:\n\s+postgres-check:\n\s+condition: service_completed_successfully/);
    expect(guard).toContain('PG_VERSION');
    expect(guard).toMatch(/restart: "no"/);
    expect(guard).toContain('/var/lib/postgresql/data:ro');
    expect(guard).toContain('postgres:18-alpine@sha256:');
    // One volume layout for both majors, so POSTGRES_IMAGE can keep an install on 16.
    expect(postgres).toContain('PGDATA: /var/lib/postgresql/data');
    expect(postgres).toContain('${POSTGRES_IMAGE:-postgres:18-alpine@sha256:');
    expect(envExample).toMatch(/^# POSTGRES_IMAGE=postgres:18-alpine@sha256:/m);
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
    expect(app).toMatch(/"\$\{PUBLIC_BIND:-127\.0\.0\.1:3201\}:\$\{PUBLIC_PORT:-3001\}"/);
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
    expect(envExample).toMatch(/^# PUBLIC_BIND=127\.0\.0\.1:3201$/m);
    expect(envExample).toMatch(/PUBLIC_BIND[\s\S]{0,300}(tunnel|network)/i);
  });

  it('documents the admin port bind address beside the public one (#870)', () => {
    expect(envExample).toMatch(/^# AM_BIND=127\.0\.0\.1$/m);
    expect(envExample).toMatch(/AM_BIND[\s\S]{0,400}(0\.0\.0\.0|loopback|interface)/i);
  });

  it('leaves the database passwords empty so a copied template cannot start (#870)', () => {
    expect(envExample).toMatch(/^POSTGRES_PASSWORD=$/m);
    expect(envExample).toMatch(/^APP_DB_PASSWORD=$/m);
    // Compose's `:?` check fails on an empty value too, not only on an unset one.
    expect(service(compose, 'postgres')).toContain('${POSTGRES_PASSWORD:?');
    expect(service(compose, 'app')).toContain('${APP_DB_PASSWORD:?');
    // Nothing may still advertise the old known password, including the dev DATABASE_URL.
    expect(envExample).not.toContain('change-me');
  });

  it('documents every variable the server reads, including runtime plumbing (#387)', () => {
    const documented = new Set(envFileKeys(envExample));
    expect(ENV_KEYS.filter((key) => !documented.has(key))).toEqual([]);
    expect(documented.has('LOG_LEVEL')).toBe(true);
    expect(envExample).toMatch(/^# LOG_LEVEL=info$/m);
  });
});

describe('compose environment completeness (#385)', () => {
  const app = service(compose, 'app');
  const passed = new Set([...app.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]));

  it('passes every server variable into the app container', () => {
    expect(ENV_KEYS.filter((key) => !passed.has(key))).toEqual([]);
  });

  it('keeps optional values empty-safe and requires only the secrets a start cannot do without', () => {
    for (const key of ENV_KEYS) {
      const line = app.split('\n').find((candidate) => candidate.trimStart().startsWith(`${key}:`));
      expect(line, `${key} is missing from the app environment`).toBeTruthy();
      const reference = `\${${key}`;
      if (line?.includes(reference)) expect(line).toMatch(new RegExp(`\\$\\{${key}:(?:-|\\?)`));
    }
  });

  it('gives the scheduled backup service the verify-age setting', () => {
    expect(composeOverride).toContain('BACKUP_VERIFY_MAX_AGE_DAYS');
  });

  it('documents that Compose now forwards every documented variable', () => {
    expect(composeDoc).toContain('Every variable the server reads is passed into the `app` container');
  });
});

// #965: the #385 guard above keys off config.ts's Env schema, so a variable the server reads from
// process.env directly (the three OTLP settings #931 introduced, for example) could be documented
// and still never reach the container. Compose without env_file and the chart's ConfigMap are
// explicit allow-lists, so this scans the source instead of a schema. The scan follows a variable,
// a default parameter, a parameter typed as an environment map, destructuring and constant keys
// (apps/server/test/env-reads.ts); an access it cannot resolve fails until it is named below.
describe('every environment read reaches the containers (#965)', () => {
  // Read by the server-side source but deliberately not part of a deployment's configuration.
  const NOT_FORWARDED = new Map([
    [
      'INIT_CWD',
      'pnpm sets it to the directory the command ran in; the CLI resolves .env, CHANGELOG and --env-file paths from it. Compose and Helm run `am` directly, so no pnpm and no value.',
    ],
    ['AM_TOKEN', 'an input to the `am smoke` helper only (apps/server/src/ops/smoke.ts); the server itself never reads it.'],
    ['AM_GIT_SHA', 'baked into the image by the Dockerfile (ARG GIT_SHA), so the build sets it, never the operator.'],
    [
      'CAMPAIGN_IDENTITY_SCOPE_LIMIT',
      'a test-only override of the campaign identity scope bound (packages/campaigns/src/identity.ts); production never sets it.',
    ],
    [
      'AM_BOOTSTRAP_PASSWORD',
      'a CLI-only input to `am bootstrap` (apps/server/src/cli.ts, via resolvePassword): .env.example documents it as not server configuration, and putting an admin password into every container buys nothing.',
    ],
    ['AM_RESET_PASSWORD', 'the CLI-only counterpart for `am reset-password`; same reason. Neither is read by the running server.'],
    [
      'AM_BIND',
      'the host address the admin port is published on: a Compose interpolation value for `ports:`, not what the container binds (PORT). The doctor reads it only to describe the host side and falls back to docker-compose.yml, so forwarding it would report the host port as the container port.',
    ],
    [
      'AM_PORT',
      'the published admin port, the same Compose host-side setting as AM_BIND. The container listens on PORT; AM_PORT never reaches it.',
    ],
    [
      'PUBLIC_BIND',
      'the host:port the public listener is published on; the container sees PUBLIC_PORT. The doctor describes the host side from it and falls back to docker-compose.yml.',
    ],
    [
      'POSTGRES_PASSWORD',
      'the Postgres superuser password, which Compose interpolates into DATABASE_URL. The app connects as APP_DB_ROLE under row-level security and never needs this password, so it stays out of the app container (least privilege); the doctor says when it is not set here.',
    ],
  ]);

  // An environment access the syntax scan cannot reduce to a name. Each needs a reason here, and
  // the test fails if an entry stops matching a real finding, so this cannot become a blanket pass.
  const DYNAMIC_READS = new Map([
    [
      'apps/server/src/config.ts|enumerate',
      'loadConfig enumerates the whole environment once and validates it with the Env schema. Every name it accepts is an ENV_KEYS entry, and the completeness tests above require each of those in Compose and the chart, so the names are known even though this access is not.',
    ],
  ]);

  const id = (file: string, kind: string) => `${file}|${kind}`;

  it('forwards every environment read through Compose and the chart', async () => {
    const scan = await scanServerSources(root);
    const reads = new Set(scan.reads.map((read) => read.key));
    // The scan must find the reads this guard was written for, by every spelling, or a broken
    // resolver would pass silently: a property access, a constant-keyed access, and a helper call.
    for (const key of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
      'BACKUP_KEEP_DAYS',
      'BETTER_AUTH_TRUSTED_ORIGINS',
      'AM_BOOTSTRAP_PASSWORD',
      'AM_RESET_PASSWORD',
    ]) {
      expect(reads.has(key), `${key} was not found in the server-side source`).toBe(true);
    }
    // A key reached through a bound environment object, not a literal `process.env.X` (#965 review).
    expect(scan.reads.find((read) => read.key === 'BACKUP_KEEP_DAYS')?.file).toBe('apps/server/src/ops/backup-lib.ts');

    const composeKeys = new Set([...service(compose, 'app').matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]));
    const helmConfig = new Set([...helmSection(helmValues, 'config').matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]));
    const helmSecretExamples = new Set(
      [...helmSection(helmValues, 'secrets').matchAll(/^ {2}#\s+([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]),
    );

    const missing: string[] = [];
    for (const key of [...reads].sort()) {
      if (NOT_FORWARDED.has(key)) continue;
      if (!composeKeys.has(key)) missing.push(`docker-compose.yml app environment: ${key}`);
      // A key is forwarded by the chart either as a plain `config` value or through the Secret the
      // roles read with envFrom: `secrets.values` accepts any key, and its documented examples are
      // the chart's statement of what belongs there (a credential stays out of the ConfigMap).
      if (!helmConfig.has(key) && !helmSecretExamples.has(key)) missing.push(`Helm config (or a documented secrets.values key): ${key}`);
    }
    expect(missing).toEqual([]);

    // Every exception must still describe a real read, so the lists cannot rot into a blanket pass.
    expect([...NOT_FORWARDED.keys()].filter((key) => !reads.has(key))).toEqual([]);
    // The credential keys that motivated the Secret rule (#965) stay documented there.
    for (const key of ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS']) {
      expect(helmSecretExamples.has(key), `${key} must be documented under secrets.values`).toBe(true);
    }
  });

  it('names every environment access the scan cannot resolve', async () => {
    const scan = await scanServerSources(root);
    const findings = scan.dynamic.map((read) => ({ id: id(read.file, read.kind), where: `${read.file}:${read.line}`, text: read.text }));

    const unexplained = findings
      .filter((finding) => !DYNAMIC_READS.has(finding.id))
      .map((finding) => `${finding.where} (${finding.id}): ${finding.text}`);
    expect(unexplained).toEqual([]);
    // And an entry that no longer matches a finding is stale, not permission for the next one.
    expect([...DYNAMIC_READS.keys()].filter((entry) => !findings.some((finding) => finding.id === entry))).toEqual([]);
  });
});

describe('Helm rollout, migration and replica reporting', () => {
  it('checksums the ConfigMap and the Secret, and offers a revision for external Secrets (#388)', () => {
    expect(helmDeployments).toContain('checksum/config:');
    expect(helmDeployments).toContain('checksum/secret:');
    expect(helmDeployments).toContain('checksum/secret-revision:');
    expect(helmValues).toMatch(/^\s+revision:\s*""/m);
    expect(kubeDoc).toContain('secrets.revision');
    expect(kubeDoc).toContain('kubectl rollout restart');
  });

  it('recreates every writer role by default and renders RollingUpdate when drained externally (#1066)', () => {
    // The 0.15.0 lock protocol forbids two writers of different versions at once. One strategy line
    // covers every role in the range; api, ingest, worker and scheduler all write.
    expect(helmDeployments).toMatch(/strategy: \{ type: \{\{ \$\.Values\.upgradeStrategy \}\} \}/);
    const strategy = helmDeployments.indexOf('strategy: { type: {{ $.Values.upgradeStrategy }} }');
    expect(strategy).toBeGreaterThan(0);
    expect(helmDeployments.slice(0, strategy)).not.toContain('if eq $role "scheduler"');
    expect(helmDeployments.slice(0, strategy)).toContain('range $role, $r := .Values.roles');
    expect(helmValues).toMatch(/^upgradeStrategy: Recreate$/m);
    expect(helmValues).toMatch(/RollingUpdate/);

    const render = (value: string) => helmDeployments.replace('{{ $.Values.upgradeStrategy }}', value);
    expect(render('Recreate')).toContain('strategy: { type: Recreate }');
    expect(render('RollingUpdate')).toContain('strategy: { type: RollingUpdate }');
  });

  it('migrates before the roles on install and upgrade, without a post-install readiness deadlock (#389)', () => {
    expect(helmMigrateJob).toMatch(/helm\.sh\/hook:\s*pre-install,pre-upgrade/);
    expect(helmMigrateJob).not.toMatch(/helm\.sh\/hook:.*post-install/);
    expect(helmMigrateJob).toContain('range $k, $v := .Values.config');
    expect(helmMigrateJob).not.toContain('configMapRef');
    expect(helmMigrateJob).toContain('-migrate-secrets');
    expect(helmMigrateJob).toContain('if not .Values.serviceAccount.create');
    expect(kubeDoc).toContain('pre-install/pre-upgrade');
    expect(kubeDoc).toMatch(/--wait/);
    expect(kubeDoc).toMatch(/forward-only/i);
  });

  it('gives the migration Job the same resource pattern as the roles (#390)', () => {
    expect(helmMigrateJob).toContain('resources: {{- toYaml .Values.migrations.resources');
    expect(helmValues).toMatch(/migrations:[\s\S]{0,400}resources:/);
  });

  it('prints the configured or autoscaled replicas, including the scheduler (#391)', () => {
    expect(helmNotes).not.toMatch(/scheduler \(1\)/);
    expect(helmNotes).toContain('am.roleReplicas');
    expect(helmNotes).toContain('.Values.roles.scheduler');
    expect(helmHelpers).toContain('define "am.roleReplicas"');
    expect(helmHpa).toContain('range $role, $r := .Values.roles');
  });
});

describe('Helm role ports and probes (#645, #649)', () => {
  // The chart has no render test of its own (CI runs `helm lint` and kubeconform), and the pinned
  // helm binary is not installed everywhere, so these checks read the templates. They cover the
  // worker/scheduler probes and the single port.
  const container = helmDeployments.slice(helmDeployments.indexOf('containers:'));

  it('puts the container port and the HTTP probes behind the api/ingest role check', () => {
    expect(helmDeployments).toMatch(/\$httpRole\s*:=\s*or \(eq \$role "api"\) \(eq \$role "ingest"\)/);
    const guarded = /\{\{- if \$httpRole \}\}\n([\s\S]*?)\n\s*\{\{- end \}\}/.exec(container)?.[1] ?? '';
    expect(guarded).toContain('ports:');
    expect(guarded).toContain('livenessProbe:');
    expect(guarded).toContain('httpGet: { path: /healthz, port: http }');
    expect(guarded).toContain('readinessProbe:');
    expect(guarded).toContain('httpGet: { path: /readyz, port: http }');
    expect(guarded).toContain('containerPort: {{ $.Values.port }}');

    // Nothing outside the guard may bind a port or probe worker/scheduler.
    const unguarded = container.replace(guarded, '');
    expect(unguarded).not.toContain('containerPort:');
    expect(unguarded).not.toContain('livenessProbe:');
    expect(unguarded).not.toContain('readinessProbe:');
    expect(unguarded).not.toContain('/healthz');
    expect(unguarded).not.toContain('/readyz');
  });

  it('uses one port value for the ConfigMap, container, Service and migrate hook', () => {
    expect(helmValues).toMatch(/^port: 3000$/m);
    expect(helmConfigMap).toMatch(/PORT: \{\{ \.Values\.port \| quote \}\}/);
    expect(helmConfigMap).not.toMatch(/PORT:\s*"3000"/);
    expect(container).not.toMatch(/containerPort:\s*3000/);
    expect(helmServices).toContain('targetPort: {{ $.Values.port }}');
    expect(helmMigrateJob).toMatch(/value: \{\{ \.Values\.port \| quote \}\}/);
    expect(helmMigrateJob).not.toMatch(/value:\s*"3000"/);
  });

  it('keeps a config.PORT from duplicating the ConfigMap key (#649)', () => {
    // The migrate Job guards this already; the ConfigMap must use the same guard.
    expect(helmMigrateJob).toContain('hasKey .Values.config "PORT"');
    expect(helmConfigMap).toContain('hasKey .Values.config "PORT"');
  });

  it('documents why worker and scheduler have no probes (#645)', () => {
    expect(kubeDoc).toContain('so they get no probe');
  });
});

describe('Helm refuses a divergent config.PORT (#774)', () => {
  it('fails the render instead of leaving the probes on another port', () => {
    // The template reads like the ingress/hpa guards; CI renders the failing case because helm is
    // only installed there.
    expect(helmConfigMap).toContain('hasKey .Values.config "PORT"');
    expect(helmConfigMap).toMatch(/\{\{- fail .*config\.PORT is %s but the chart's port is %s/);
    expect(helmConfigMap).toContain('Remove config.PORT and set port');
  });

  it('renders the mismatch in CI and expects the failure', () => {
    expect(ci).toContain('--set config.PORT=3001');
    expect(ci).toContain("grep -q 'config.PORT is 3001'");
  });
});

describe('smoke test', () => {
  it('always uses the source-build overlay, including logs and down', () => {
    expect(smoke).toContain('-f docker-compose.yml -f docker-compose.build.yml');
    expect(smoke).toMatch(/trap cleanup EXIT/);
    expect(smoke).toMatch(/dc logs app[\s\S]*dc down -v/);
    expect(smoke).toContain('SMOKE_NO_BUILD');
  });

  it('gives every run its own project, temp files and port (#870)', () => {
    // A fixed project name let a second run's `down -v` remove the first run's containers and volume.
    expect(smoke).not.toContain('COMPOSE_PROJECT_NAME=am_smoke');
    expect(smoke).toMatch(/RUN_ID=.*\$\$/);
    expect(smoke).toMatch(/RUN_ID=.*RANDOM/);
    expect(smoke).toContain('COMPOSE_PROJECT_NAME="$RUN_ID"');
    // Temp files belong to the run: an env file, a cookie jar, and nothing shared under /tmp.
    expect(smoke).not.toContain('/tmp/am_smoke_cookies');
    expect(smoke.match(/mktemp/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Its own port, never a fixed 3000 that an installed stack may hold: Docker assigns it when the
    // container starts (port 0) and the script reads it back, so no other run can take it between
    // selection and `up` (#877). SMOKE_PORT still pins one.
    expect(smoke).not.toMatch(/AM_PORT=3000\b/);
    expect(smoke).toMatch(/SMOKE_PORT:-0/);
    expect(smoke).toMatch(/AM_PORT=\$admin_host_port\b/);
    expect(smoke).toMatch(/dc port app/);
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

describe('image pinning (#870)', () => {
  const isAppImage = (ref: string) => /\$\{AM_(?:VERSION|BUILD_IMAGE)/.test(ref);
  const images = (text: string) => [...text.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1]);

  it('pins every Dockerfile stage by digest, with the tag still readable', () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
    const stages = new Set([...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((match) => match[1]));
    expect(froms.length).toBeGreaterThan(0);
    let imageCount = 0;
    for (const ref of froms) {
      if (stages.has(ref)) continue; // an earlier stage in this file, not an image
      imageCount += 1;
      expect(ref, `${ref} is not pinned by digest`).toMatch(/@sha256:[0-9a-f]{64}$/);
      // image:tag@sha256:… keeps the human-readable version beside the immutable digest.
      expect(ref).toMatch(/:[^:@/]+@sha256:/);
    }
    expect(imageCount).toBeGreaterThan(0);
  });

  it('pins every service image in every Compose file by digest', () => {
    const files: Array<[string, string]> = [
      ['docker-compose.yml', compose],
      ['docker-compose.test.yml', composeTest],
      ['docker-compose.build.yml', buildOverlay],
    ];
    for (const [file, text] of files) {
      const refs = images(text);
      expect(refs.length, `${file} has no images`).toBeGreaterThan(0);
      for (const raw of refs) {
        // The release and source-build images are selected by version, not by digest.
        if (isAppImage(raw)) continue;
        // A service image may be overridable (`${POSTGRES_IMAGE:-postgres:18-alpine@sha256:…}`);
        // the default is what ships, so it is the part that must be pinned.
        const ref = raw.replace(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}$/, '$1');
        expect(ref, `${file}: ${ref} is not pinned by digest`).toMatch(/@sha256:[0-9a-f]{64}$/);
        expect(ref, `${file}: ${ref} lost its tag`).toMatch(/:[^:@/]+@sha256:/);
      }
    }
  });

  it('keeps the released image tag readable beside its version variable', () => {
    expect(compose).toMatch(/image:\s*ghcr\.io\/timchr78\/agentic-marketing:\$\{AM_VERSION:-\d+\.\d+\.\d+\}/);
  });
});

describe('image healthcheck (#870)', () => {
  const script = join(root, 'scripts/healthcheck.mjs');
  const probe = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...env } });

  it('passes for roles that start no HTTP listener, without one to reach', () => {
    // Only api and ingest listen (apps/server/src/main.ts). PORT=1 has nothing behind it, so a
    // probe here would fail if the script ignored ROLE; #645 is the same bug in the Helm chart.
    for (const role of ['worker', 'scheduler', 'worker,scheduler']) {
      const result = probe({ ROLE: role, PORT: '1' });
      expect(result.status, `${role}: ${result.stderr}`).toBe(0);
    }
  });

  it('still probes /readyz for a role that listens', () => {
    expect(probe({ ROLE: 'api', PORT: '1', HEALTHCHECK_TIMEOUT_MS: '1000' }).status).toBe(1);
    expect(probe({ ROLE: 'ingest', PORT: '1', HEALTHCHECK_TIMEOUT_MS: '1000' }).status).toBe(1);
  });

  it('installs the probe in the image and keeps the Helm role check', () => {
    expect(dockerfile).toContain('COPY scripts/healthcheck.mjs /usr/local/bin/healthcheck.mjs');
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]{0,400}CMD \["node", "\/usr\/local\/bin\/healthcheck\.mjs"\]/);
    expect(dockerfile).not.toMatch(/HEALTHCHECK[\s\S]{0,400}\/readyz/);
    // The chart's own guard is the reference: api and ingest get the HTTP probes, nothing else does.
    expect(helmDeployments).toMatch(/\$httpRole\s*:=\s*or \(eq \$role "api"\) \(eq \$role "ingest"\)/);
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

describe('Helm chart client IP trust', () => {
  it('refuses to render an Ingress without trusted proxy ranges', () => {
    expect(helmValues).toMatch(/^\s*TRUSTED_PROXY_CIDRS:\s*""/m);
    expect(helmIngress).toMatch(/if \.Values\.ingress\.enabled/);
    expect(helmIngress).toContain('fail');
    expect(helmIngress).toContain('config.TRUSTED_PROXY_CIDRS');
    expect(helmIngress).toContain('docs/deployment/kubernetes.md#client-ip-behind-the-ingress');
  });

  it('renders the Ingress in CI with a trusted proxy range', () => {
    expect(ci).toMatch(/helm template[\s\S]{0,400}--set ingress\.enabled=true[\s\S]{0,200}--set config\.TRUSTED_PROXY_CIDRS=\S+/);
  });

  it('documents how to find the ingress controller ranges', () => {
    expect(kubeDoc).toContain('## Client IP behind the Ingress');
    expect(kubeDoc).toContain('TRUSTED_PROXY_CIDRS');
    expect(kubeDoc).toMatch(/kubectl get pods[\s\S]{0,200}-o wide/);
    expect(kubeDoc).toMatch(/right to left/i);
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
