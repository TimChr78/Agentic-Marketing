import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 18 (#227, narrow #85): the versioned business_context artifact every agent reads
// first, as workspace.businessContext and the MCP resource business-context://current.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let token = '';
let agent: Awaited<ReturnType<typeof connectAgent>>;

const businessContext = {
  summary: 'A weekly newsletter about practical martech for small marketing teams.',
  audience: 'Marketing leads at companies with 10–200 people.',
  offer: 'A free weekly issue with one idea they can ship before the next one arrives.',
  voice: 'Direct, warm and specific. No hype, no jargon, no exclamation marks.',
  avoid: ['guaranteed results', 'growth hacking', 'best-in-class'],
  legal: 'Include the unsubscribe link and the company’s postal address in every issue.',
  links: [{ label: 'Newsletter', url: 'https://example.com/newsletter' }],
};

beforeAll(async () => {
  t = await startTestServer('test_business_context', testPort(3482));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  token = (await t.api(owner).call('apiTokens.create', { name: 'Brief reader', scopes: ['artifacts:read'] })).token;
  agent = await connectAgent(t.base, owner, ['artifacts:read']);
}, 60_000);
afterAll(() => t?.close());

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('the business context (#227)', () => {
  it('returns null with a hint before one is published', async () => {
    const out = await call('workspace.businessContext');
    expect(out.status).toBe(200);
    expect(out.body.content).toBeNull();
    expect(out.body.version).toBeNull();
    expect(out.body.updatedAt).toBeNull();
    expect(out.body.hint).toContain('artifacts.create');
  });

  it('an owner publishes one and reads it back', async () => {
    const api = t.api(owner);
    const created = await api.call('artifacts.create', { type: 'business_context', name: 'Business context', content: businessContext });
    const published = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'The brief agents start from' });
    expect(published.status).toBe('published');

    const out = await api.call('workspace.businessContext', {});
    expect(out.content).toEqual(businessContext);
    expect(out.version).toBe(1);
    expect(out.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.hint).toBeNull();
  });

  it('an agent reads the same content through REST and the MCP resource', async () => {
    const rest = await call('workspace.businessContext');
    expect(rest.status).toBe(200);
    expect(rest.body.content).toEqual(businessContext);

    const { resources } = await agent.client.listResources();
    expect(resources.find((r) => r.uri === 'business-context://current')).toMatchObject({ mimeType: 'application/json' });

    const read = await agent.client.readResource({ uri: 'business-context://current' });
    const text = (read.contents[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual(rest.body);
    expect(JSON.parse(text).content).toEqual(businessContext);
  });

  it('the MCP instructions point at the brief', () => {
    const instructions = agent.client.getInstructions();
    expect(instructions).toContain('business-context://current');
    expect(instructions).toMatch(/voice|claims to avoid|legal lines/);
  });
});
