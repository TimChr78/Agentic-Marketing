import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Fixes from the audit of the agent controls (0.4.1): config.import decides each publish like
// artifacts.requestPublish (#239), concurrent requests cannot exceed a daily limit (#240), held
// changes are counted and explained (#244, #245), an unknown type is invalid input (#247).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let token = '';
let agentId = '';
let segment = '';
let templateId = '';

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';

beforeAll(async () => {
  t = await startTestServer('test_audit_agents', testPort(3483));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  // Policy `none`: agents publish directly unless the policy engine sends a change to a person.
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });
  const tpl = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Issue',
    content: { purpose: 'marketing_email', subject: 'This week', mjml },
  });
  await api.call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'setup' });
  templateId = tpl.artifactId;
  await api.call('profiles.import', {
    label: 'Audit test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  const seg = await api.call('artifacts.create', {
    type: 'segment',
    name: 'Everyone',
    content: { condition: { consent: 'marketing_email' } },
  });
  await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
  segment = seg.artifactId;
  await eventually(
    () => api.call('segments.refresh', { artifactId: segment }),
    (r) => r.members === 3,
  );
  token = (
    await api.call('apiTokens.create', {
      name: 'Importer',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'audit:read'],
    })
  ).token;
  agentId = (await call('agents.get')).body.id;
}, 90_000);
afterAll(() => t?.close());

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const bundle = (artifacts: { id: string; type: string; name: string; content: unknown }[]) => ({
  bundle: { format: 'agentic-marketing/artifacts@1', artifacts },
  dryRun: false,
  publish: true,
  note: 'Import from staging',
});

describe('config.import decides each publish (#239)', () => {
  it('a broadcast above the audience threshold is not published directly', async () => {
    await t.api(owner).call('workspace.setAutonomy', { audienceThreshold: 2 });
    const id = newId('bct');
    const out = await call(
      'config.import',
      bundle([{ id, type: 'broadcast', name: 'Imported issue', content: { template: templateId, segment } }]),
    );
    expect(out.status).toBe(200);
    expect(out.body.changes[0]).toMatchObject({ id, publish: 'in_review' });
    expect((await t.api(owner).call('artifacts.get', { artifactId: id })).publishedVersion).toBeNull();
    const { actions } = await t.api(owner).call('agents.activity', { agentId, limit: 5 });
    expect(actions.find((a) => a.command === 'artifacts.requestPublish' && a.target === id)).toMatchObject({
      decision: 'ask',
      actionClass: 'send.broadcast',
      impact: { people: 3 },
    });
    await t.api(owner).call('workspace.setAutonomy', { audienceThreshold: 1000 });
  });

  it('within the threshold it publishes, recorded per artifact', async () => {
    const id = newId('bct');
    const out = await call(
      'config.import',
      bundle([{ id, type: 'broadcast', name: 'Small issue', content: { template: templateId, segment } }]),
    );
    expect(out.body.changes[0]).toMatchObject({ id, publish: 'published' });
    const { actions } = await t.api(owner).call('agents.activity', { agentId, limit: 5 });
    expect(actions.find((a) => a.command === 'artifacts.requestPublish' && a.target === id)).toMatchObject({ decision: 'allow' });
  });

  it('an unknown type is invalid input, not a server error (#247)', async () => {
    const out = await call('config.import', bundle([{ id: newId('xyz'), type: 'not_a_type', name: 'x', content: {} }]));
    expect(out.status).toBe(400);
  });
});

describe('concurrent requests and a daily limit (#240)', () => {
  it('only as many changes run as the limit allows; the rest wait for a person', async () => {
    const drafts = [];
    for (let i = 0; i < 5; i++)
      drafts.push(
        (
          await call('artifacts.create', {
            type: 'email_template',
            name: `Race ${i}`,
            content: { purpose: 'marketing_email', subject: 'R', mjml },
          })
        ).body.artifactId as string,
      );
    const { last24h } = (await call('agents.get')).body;
    await t.api(owner).call('workspace.setAutonomy', { limits: { changesPerDay: last24h.changes + 1 } });
    const results = await Promise.all(drafts.map((artifactId) => call('artifacts.requestPublish', { artifactId, note: 'race' })));
    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(['in_review', 'in_review', 'in_review', 'in_review', 'published']);
    await t.api(owner).call('workspace.setAutonomy', { limits: { changesPerDay: 500 } });
  });
});
