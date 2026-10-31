import { type ArtifactType, validateContent } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, rejects, startTestServer, testPort, type User } from './harness';

// Recipes (#150): curated bundles of artifacts that install as drafts. The tests cover the gallery
// reads, the prerequisite check (the most common missing one is an e-mail provider for marketing),
// an install that resolves references between the new drafts and publishes nothing, and the
// approval path for an agent.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agent: Awaited<ReturnType<typeof connectAgent>>;

beforeAll(async () => {
  t = await startTestServer('test_recipes', testPort(2502));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  // agent_changes: an agent's install is a draft change; its publish waits for a person.
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');
  agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
}, 60_000);
afterAll(() => t?.close());

const mcp = async (name: string, args: unknown = {}) =>
  (await agent.client.callTool({ name, arguments: args as Record<string, unknown> })) as any;

const RECIPE_IDS = ['lead-magnet-drip', 'weekly-newsletter', 'welcome-doi', 'win-back'];

describe('recipe gallery', () => {
  it('lists the shipped recipes with their parameters and returns one in full', async () => {
    const api = t.api(owner);
    const list = await api.call('recipes.list', {});
    expect(list.recipes.map((r) => r.id)).toEqual(RECIPE_IDS);
    const welcome = list.recipes.find((r) => r.id === 'welcome-doi');
    expect(welcome).toMatchObject({ version: 1, artifacts: 6, prerequisites: 2 });
    expect(welcome?.parameters.map((p) => p.key)).toEqual(['siteName', 'siteUrl', 'purpose', 'welcomeDelay']);

    const got = await api.call('recipes.get', { recipeId: 'welcome-doi' });
    expect(got.recipe).toMatchObject({
      format: 'agentic-marketing/recipe@1',
      id: 'welcome-doi',
      version: 1,
      title: 'Welcome journey with double opt-in',
    });
    expect(got.recipe.parameters.find((p) => p.key === 'siteUrl')).toMatchObject({ type: 'url', required: true });
    expect(got.recipe.artifacts).toHaveLength(6);
    expect(got.recipe.docs).toContain('double opt-in');
    expect(got.recipe.checklist.length).toBeGreaterThan(0);

    const missing = await rejects(api.call('recipes.get', { recipeId: 'does-not-exist' }));
    expect(missing.code).toBe('not_found');
  });
});

describe('recipe preview', () => {
  it('reports the missing marketing provider and resolves the artifacts without writing', async () => {
    const api = t.api(owner);
    const preview = await api.call('recipes.preview', { recipeId: 'weekly-newsletter', params: { issueTitle: 'Founding issue' } });
    expect(preview.recipe).toMatchObject({ id: 'weekly-newsletter', version: 1 });
    expect(preview.params).toMatchObject({ issueTitle: 'Founding issue', purpose: 'marketing_email' });

    // The missing provider is the blocking prerequisite in a fresh workspace.
    const provider = preview.prerequisites.find((p) => p.kind === 'email_provider');
    expect(provider).toMatchObject({ ok: false });
    expect(provider?.message).toMatch(/No enabled e-mail provider is set up for marketing mail/);
    expect(preview.prerequisites.find((p) => p.kind === 'purpose')).toMatchObject({ ok: true });
    expect(preview.ready).toBe(false);

    // The resolved artifacts refer to each other and no placeholder is left.
    const byKey = new Map(preview.artifacts.map((a) => [a.key, a]));
    const template = byKey.get('newsletterTemplate');
    const broadcast = byKey.get('newsletterBroadcast');
    const segment = byKey.get('subscribers');
    expect(template?.type).toBe('email_template');
    expect((broadcast!.content as { template: string }).template).toBe(template?.id);
    expect((broadcast!.content as { segment: string }).segment).toBe(segment?.id);
    expect(JSON.stringify(preview.artifacts)).not.toMatch(/\{\{\s*(param|ref)\./);

    // Preview wrote nothing.
    expect((await api.call('artifacts.list', { limit: 200 })).artifacts).toHaveLength(0);
    expect((await api.call('approvals.list', { status: 'pending' })).approvals).toHaveLength(0);
  });

  it('rejects missing required parameters and unknown keys with a clear message', async () => {
    const api = t.api(owner);
    const unknown = await rejects(api.call('recipes.preview', { recipeId: 'welcome-doi', params: { nope: 'x' } }));
    expect(unknown.code).toBe('invalid_input');
    expect(unknown.message).toMatch(/Unknown parameter: nope/);
    const badDuration = await rejects(api.call('recipes.preview', { recipeId: 'welcome-doi', params: { welcomeDelay: 'three days' } }));
    expect(badDuration.message).toMatch(/welcomeDelay/);
  });
});

describe('recipe install', () => {
  it('creates drafts with resolved references and publishes nothing', async () => {
    const api = t.api(owner);
    await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });

    const install = await api.call('recipes.install', { recipeId: 'weekly-newsletter', params: { issueTitle: 'Issue one' } });
    expect(install.artifacts).toHaveLength(3);
    expect(install.artifacts.every((a) => a.state === 'draft' && a.version === 1)).toBe(true);
    expect(install.params).toMatchObject({ issueTitle: 'Issue one', segmentName: 'Newsletter subscribers' });
    expect(install.next).toMatch(/requestPublishBundle/);

    const byKey = new Map(install.artifacts.map((a) => [a.key, a]));
    const template = byKey.get('newsletterTemplate');
    const broadcast = byKey.get('newsletterBroadcast');
    const segment = byKey.get('subscribers');
    for (const a of install.artifacts) {
      const got = await api.call('artifacts.get', { artifactId: a.artifactId });
      expect(got).toMatchObject({ type: a.type, name: a.name, publishedVersion: null });
      expect(got.version.state).toBe('draft');
    }

    const broadcastContent = (await api.call('artifacts.get', { artifactId: broadcast!.artifactId })).version.content as {
      template: string;
      segment: string;
      sendAt?: string;
    };
    expect(broadcastContent.template).toBe(template!.artifactId);
    expect(broadcastContent.segment).toBe(segment!.artifactId);
    expect(broadcastContent.sendAt).toBeUndefined();

    // Nothing published, nothing waiting for approval.
    expect((await api.call('artifacts.list', { limit: 200 })).artifacts.every((a) => a.publishedVersion === null)).toBe(true);
    expect((await api.call('approvals.list', { status: 'pending' })).approvals).toHaveLength(0);

    // Installing again makes fresh ids instead of overwriting the first set.
    const again = await api.call('recipes.install', { recipeId: 'weekly-newsletter', params: { issueTitle: 'Issue one' } });
    expect(again.artifacts.map((a) => a.artifactId)).not.toEqual(install.artifacts.map((a) => a.artifactId));
  });

  it('blocks an install when a prerequisite is missing', async () => {
    const other = await t.signUp(`recipes-${Date.now()}@example.com`);
    await t.workspaceWith([[other, 'owner']], 'none');
    const failed = await rejects(t.api(other).call('recipes.install', { recipeId: 'welcome-doi', params: {} }));
    expect(failed.code).toBe('invalid_input');
    expect(failed.message).toMatch(/Cannot install "Welcome journey with double opt-in" yet/);
    expect(failed.message).toMatch(/e-mail provider/);
  });

  it('every initial recipe installs drafts whose content passes publish-time validation', async () => {
    const api = t.api(owner);
    const list = await api.call('recipes.list', {});
    for (const summary of list.recipes) {
      const preview = await api.call('recipes.preview', { recipeId: summary.id, params: {} });
      expect(preview.ready, summary.id).toBe(true);
      const install = await api.call('recipes.install', { recipeId: summary.id, params: {} });
      expect(install.artifacts.length, summary.id).toBe(summary.artifacts);
      for (const artifact of install.artifacts) {
        const got = await api.call('artifacts.get', { artifactId: artifact.artifactId });
        expect(got.version.state, `${summary.id}/${artifact.key}`).toBe('draft');
        expect(
          () => validateContent(artifact.type as ArtifactType, got.version.content, 'publish'),
          `${summary.id}/${artifact.key}`,
        ).not.toThrow();
      }
    }
  });

  it('lets an agent install drafts, but its publish follows the approval policy', async () => {
    const installed = await mcp('recipes.install', { recipeId: 'welcome-doi', params: { siteName: 'Fjeldvej' } });
    expect(installed.isError).toBeFalsy();
    expect(installed.structuredContent.artifacts).toHaveLength(6);
    const confirm = installed.structuredContent.artifacts.find((a: { key: string }) => a.key === 'confirmTemplate');
    expect(confirm.type).toBe('email_template');

    // The agent's install did not publish anything.
    const before = await t.api(owner).call('artifacts.get', { artifactId: confirm.artifactId });
    expect(before.publishedVersion).toBeNull();

    // Under "agent changes need a person", the publish becomes an approval request.
    const submitted = await mcp('artifacts.requestPublish', {
      artifactId: confirm.artifactId,
      note: 'Confirmation e-mail from the welcome recipe',
    });
    expect(submitted.isError).toBeFalsy();
    expect(submitted.structuredContent.status).toBe('in_review');
    const approvalId = submitted.structuredContent.approvalId;
    expect(approvalId).toMatch(/^apr_/);

    // An agent cannot approve its own request; a person can.
    await expect(mcp('approvals.approve', { approvalId })).rejects.toThrow(/not found/i);
    const approved = await t.api(owner).call('approvals.approve', { approvalId });
    expect(approved).toMatchObject({ status: 'approved', artifactId: confirm.artifactId, version: 1 });
    const after = await t.api(owner).call('artifacts.get', { artifactId: confirm.artifactId });
    expect(after.publishedVersion).toBe(1);
  });
});
