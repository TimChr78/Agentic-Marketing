import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../src/ops/smoke';
import { startTestServer, type User } from './harness';

// `am smoke` against a real server with the public listener enabled. Ports are unique to this file.

const MAIN_PORT = 3410;
const PUBLIC_PORT = 3411;
const SITE = 'https://public.example';

const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let token = '';
let formId = '';
let assetPath = '';

/** Keep the CLI output out of the test log and let a test inspect it. */
async function smoke(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    out.push(parts.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    err.push(parts.map(String).join(' '));
  });
  try {
    const code = await run(args);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

beforeAll(async () => {
  t = await startTestServer('test_ops_smoke', MAIN_PORT, { PUBLIC_PORT: String(PUBLIC_PORT) });
  owner = await t.signUp(`smoke-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);

  token = (await api.call('apiTokens.create', { name: 'smoke', scopes: ['workspace:admin'] })).token;
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });

  const form = await api.call('artifacts.create', {
    type: 'form',
    name: 'Smoke form',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: false,
      consentText: 'Send me the newsletter.',
      successUrl: `${SITE}/thanks`,
      confirmedUrl: `${SITE}/welcome`,
      allowedOrigins: [SITE],
    },
  });
  await api.call('artifacts.requestPublish', { artifactId: form.artifactId, note: 'ops smoke test' });
  formId = form.artifactId;

  const asset = await api.call('assets.upload', {
    fileName: 'smoke.pdf',
    contentType: 'application/pdf',
    dataBase64: pdf.toString('base64'),
  });
  assetPath = new URL(asset.url).pathname;
}, 60_000);
afterAll(() => t?.close());

describe('am smoke', () => {
  it('passes every check against a working public listener', async () => {
    const res = await smoke([
      '--public-url',
      t.publicBase!,
      '--admin-url',
      t.base,
      '--token',
      token,
      '--form',
      formId,
      '--email',
      `reader-${Date.now()}@example.com`,
      '--asset',
      assetPath,
      '--json',
    ]);

    expect(res.code, res.out).toBe(0);
    const report = JSON.parse(res.out) as { ok: boolean; checks: { id: string; status: string; detail: string }[] };
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      'public.health',
      'public.admin-hidden',
      'public.dot-segments',
      'public.assets',
      'admin.health',
      'admin.mcp',
      'admin.provider',
      'public.signup',
    ]);
    expect(report.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(report.checks.find((c) => c.id === 'admin.mcp')?.detail).toMatch(/\d+ tools available/);
    expect(report.checks.find((c) => c.id === 'admin.provider')?.detail).toContain('1 provider configured');
    expect(report.checks.find((c) => c.id === 'public.signup')?.detail).toContain(`${SITE}/thanks`);
  });

  it('fails admin-hidden when the public URL is really the admin listener', async () => {
    const res = await smoke(['--public-url', t.base, '--admin-url', t.base, '--token', token, '--json']);

    expect(res.code).toBe(1);
    const report = JSON.parse(res.out) as { ok: boolean; checks: { id: string; status: string; detail: string }[] };
    expect(report.ok).toBe(false);
    const hidden = report.checks.find((c) => c.id === 'public.admin-hidden');
    expect(hidden?.status).toBe('fail');
    expect(hidden?.detail).toContain('expected 404');
    expect(report.checks.find((c) => c.id === 'public.assets')?.status).toBe('skip');
    expect(report.checks.find((c) => c.id === 'public.signup')?.status).toBe('skip');
  });

  it('prints usage and exits 2 without --public-url', async () => {
    const res = await smoke([]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('usage: am smoke --public-url URL');
  });
});
