import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Phase 10 (wave 2), part c: config as code. A staging workspace's artifacts go to a bundle and
// into production with their ids, so references between them hold; the git script round-trips
// them through files, and an agent's import waits for approval like any agent edit.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let staging = '';
let production = '';

const mjml = (text: string) => `<mjml><mj-body><mj-section><mj-column><mj-text>${text}</mj-text></mj-column></mj-section></mj-body></mjml>`;

beforeAll(async () => {
  t = await startTestServer('test_p10_config', testPort(3290));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  staging = await t.workspaceWith([[owner, 'owner']]);
  production = await t.workspaceWith([[owner, 'owner']], 'agent_changes');
}, 60_000);
afterAll(() => t?.close());

async function build() {
  const api = t.api(owner, staging);
  const publish = async (type: string, name: string, content: unknown) => {
    const a = await api.call('artifacts.create', { type: type as 'note', name, content: content as Record<string, unknown> });
    await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'staging' });
    return a.artifactId;
  };
  const buyers = await publish('segment', 'Buyers', { condition: { event: 'Order Completed' } });
  const vip = await publish('segment', 'VIP buyers', {
    condition: { all: [{ segment: buyers }, { trait: 'plan', op: 'eq', value: 'pro' }] },
  });
  const tpl = await publish('email_template', 'Thanks', { purpose: 'onboarding', subject: 'Thanks', mjml: mjml('Thanks!') });
  const journey = await publish('journey', 'VIP welcome', {
    purpose: 'onboarding',
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Became VIP', config: { segment: vip } },
      { id: 'mail', kind: 'email', label: 'Thanks', config: { template: tpl } },
    ],
  });
  return { buyers, vip, tpl, journey };
}

describe('config as code', () => {
  it('moves a set of artifacts to another workspace with their ids, in dependency order', async () => {
    const ids = await build();
    const bundle = await t.api(owner, staging).call('config.export', {});
    expect(bundle.artifacts.map((a) => a.id).sort()).toEqual(Object.values(ids).sort());

    const prod = t.api(owner, production);
    // Journey first in the file: publishing still goes segments, template, then journey.
    const reversed = { ...bundle, artifacts: [...bundle.artifacts].reverse() };
    const dry = await prod.call('config.import', { bundle: reversed });
    expect(dry.dryRun).toBe(true);
    expect(dry.changes.every((c) => c.action === 'create')).toBe(true);
    expect((await prod.call('artifacts.list', {})).artifacts).toHaveLength(0);

    const applied = await prod.call('config.import', { bundle: reversed, dryRun: false, publish: true });
    expect(applied.changes.map((c) => c.publish)).toEqual(['published', 'published', 'published', 'published']);
    const journey = await prod.call('artifacts.get', { artifactId: ids.journey });
    expect(journey.publishedVersion).toBe(1);

    const again = await prod.call('config.import', { bundle, dryRun: false, publish: true });
    expect(again.changes.every((c) => c.action === 'unchanged' && c.publish === 'skipped')).toBe(true);
  });

  it('round-trips through files with the git script; an agent token import waits for approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'am-config-'));
    const token = (
      await t
        .api(owner, production)
        .call('apiTokens.create', { name: 'ci', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
    ).token;
    const env = { ...process.env, AM_URL: t.base, AM_TOKEN: token };
    const run = (...args: string[]) =>
      promisify(execFile)('node', [fileURLToPath(new URL('../../../scripts/am-config.mjs', import.meta.url)), ...args], { env });

    expect((await run('pull', dir)).stdout).toContain('pulled 4 artifact(s)');
    const templates = join(dir, 'email_template');
    const [file] = await readdir(templates);
    expect(file).toMatch(/^thanks\.eml_[0-9a-f]{32}\.json$/);
    const tpl = JSON.parse(await readFile(join(templates, file), 'utf8'));
    tpl.content.subject = 'Thank you';
    await writeFile(join(templates, file), JSON.stringify(tpl, null, 2));

    expect((await run('push', dir)).stdout).toMatch(/update\s+email_template\s+Thanks\n.*dry run: 1 change/);
    const out = (await run('push', dir, '--apply', '--publish')).stdout;
    expect(out).toContain('→ in_review'); // the token acts as an agent; production asks a person for agent changes
    const t2 = await t.api(owner, production).call('artifacts.get', { artifactId: tpl.id });
    expect([t2.latestVersion, t2.publishedVersion]).toEqual([2, 1]);
  });
});
