import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// Workspace portability (#151): a bundle can carry the non-secret workspace settings besides the
// artifacts, config.drift reports what differs without writing, and importing the bundle into an
// empty workspace reproduces both. Secrets, credentials, API tokens, agents and people never
// travel in a bundle.

type Server = Awaited<ReturnType<typeof startTestServer>>;

const note = { title: 'Launch notes', body: 'Keep this in git.' };
const noteV2 = { title: 'Launch notes', body: 'Rewritten after the export.' };

describe('workspace portability', () => {
  let t: Server;
  let owner: User;
  let staging = '';
  let production = '';
  let noteId = '';

  beforeAll(async () => {
    t = await startTestServer('test_workspace_portability', testPort(2501));
    owner = await t.signUp(`owner-${Date.now()}@example.com`);
    staging = await t.workspaceWith([[owner, 'owner']]);
    production = await t.workspaceWith([[owner, 'owner']]);

    const api = t.api(owner, staging);
    await api.call('workspace.update', { name: 'Portable workspace', timeZone: 'Europe/Copenhagen' });
    await api.call('workspace.setApprovalPolicy', { policy: 'agent_changes' });
    await api.call('workspace.setSeedList', { seedList: ['Seed@Example.com'] });
    await api.call('workspace.setAutonomy', {
      switch: 'propose_only',
      audienceThreshold: 42,
      limits: { changesPerDay: 7 },
    });

    const created = await api.call('artifacts.create', {
      type: 'note',
      name: 'Launch notes',
      content: note,
    });
    noteId = created.artifactId;
    await api.call('artifacts.requestPublish', { artifactId: noteId, note: 'staging' });
    const segment = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Buyers',
      content: { condition: { event: 'Order Completed' } },
    });
    await api.call('artifacts.requestPublish', { artifactId: segment.artifactId, note: 'staging' });
  }, 90_000);
  afterAll(() => t?.close());

  it('exports non-secret settings beside the artifacts and no secrets at all', async () => {
    const bundle = await t.api(owner, staging).call('config.export', { includeSettings: true });
    expect(bundle.artifacts).toHaveLength(2);
    expect(Object.keys(bundle).sort()).toEqual(['artifacts', 'exportedAt', 'format', 'settings']);
    expect(bundle.settings).toMatchObject({
      name: 'Portable workspace',
      timeZone: 'Europe/Copenhagen',
      approvalPolicy: 'agent_changes',
      seedList: ['seed@example.com'],
    });
    expect(bundle.settings?.autonomy).toMatchObject({
      switch: 'propose_only',
      audienceThreshold: 42,
      limits: { changesPerDay: 7, messagesPerDay: 1000 },
    });

    const text = JSON.stringify(bundle).toLowerCase();
    for (const forbidden of ['password', 'apikey', 'api_key', 'credential', 'secret', 'token', 'privatekey'])
      expect(text).not.toContain(forbidden);
    // People, agents, providers and their credentials are not part of a bundle.
    expect(bundle).not.toHaveProperty('profiles');
    expect(bundle).not.toHaveProperty('agents');
    expect(bundle).not.toHaveProperty('apiTokens');
    expect(bundle).not.toHaveProperty('secrets');

    // Settings stay opt-in, so the existing artifact-only flow is unchanged.
    expect((await t.api(owner, staging).call('config.export', {})).settings).toBeUndefined();
  });

  it('reports drift for a changed setting and a changed artifact without writing', async () => {
    const bundle = await t.api(owner, staging).call('config.export', { includeSettings: true });
    await t.api(owner, staging).call('artifacts.updateDraft', { artifactId: noteId, content: noteV2 });
    await t.api(owner, staging).call('workspace.update', { timeZone: 'Europe/London' });

    const drift = await t.api(owner, staging).call('config.drift', { bundle });
    const changedArtifact = drift.drift.find((entry) => entry.kind === 'artifact' && entry.key === noteId);
    expect(changedArtifact).toMatchObject({ status: 'update', type: 'note' });
    expect(changedArtifact?.details?.some((detail) => detail.path === 'body')).toBe(true);

    const changedSetting = drift.drift.find((entry) => entry.kind === 'setting' && entry.key === 'timeZone');
    expect(changedSetting).toMatchObject({ status: 'update' });
    expect(changedSetting?.details).toEqual([{ path: '(root)', kind: 'changed', before: 'Europe/London', after: 'Europe/Copenhagen' }]);

    // Unchanged artifacts and settings are listed too, and the summary counts them.
    expect(drift.drift.some((entry) => entry.kind === 'artifact' && entry.status === 'unchanged')).toBe(true);
    expect(drift.summary).toEqual({ create: 0, update: 2, unchanged: 5, conflict: 0 });

    // Read-only: the drift report did not move the workspace or the drafts back.
    expect((await t.api(owner, staging).call('workspace.get', {})).timeZone).toBe('Europe/London');
    expect((await t.api(owner, staging).call('artifacts.get', { artifactId: noteId })).latestVersion).toBe(2);
    // Put the staging time zone back for the clone below; the drift report itself never wrote.
    await t.api(owner, staging).call('workspace.update', { timeZone: 'Europe/Copenhagen' });
  });

  it('clones artifacts and settings into an empty workspace', async () => {
    const bundle = await t.api(owner, staging).call('config.export', { includeSettings: true });
    const prod = t.api(owner, production);

    const dry = await prod.call('config.import', { bundle });
    expect(dry.dryRun).toBe(true);
    expect(dry.settings.find((change) => change.key === 'timeZone')).toMatchObject({
      action: 'update',
      from: expect.any(String),
      to: 'Europe/Copenhagen',
    });
    expect((await prod.call('artifacts.list', {})).artifacts).toHaveLength(0);

    const applied = await prod.call('config.import', { bundle, dryRun: false, publish: true });
    expect(applied.changes.every((change) => change.action === 'create')).toBe(true);
    expect(applied.changes.every((change) => change.publish === 'published')).toBe(true);
    expect(applied.settings.find((change) => change.key === 'seedList')).toMatchObject({ action: 'update', to: ['seed@example.com'] });

    expect(await prod.call('workspace.get', {})).toMatchObject({
      name: 'Portable workspace',
      timeZone: 'Europe/Copenhagen',
      approvalPolicy: 'agent_changes',
      seedList: ['seed@example.com'],
    });
    expect(await prod.call('workspace.autonomy', {})).toMatchObject({
      switch: 'propose_only',
      audienceThreshold: 42,
      limits: { changesPerDay: 7, messagesPerDay: 1000 },
    });
    const cloned = await prod.call('artifacts.get', { artifactId: noteId });
    expect(cloned.publishedVersion).toBe(1);
    expect(cloned.version.content).toEqual(note);

    // The clone now matches the bundle exactly.
    const after = await prod.call('config.drift', { bundle });
    expect(after.summary).toEqual({ create: 0, update: 0, unchanged: 7, conflict: 0 });
  });

  it('refuses credential-shaped settings instead of silently dropping them', async () => {
    const bundle = await t.api(owner, staging).call('config.export', { includeSettings: true });
    if (!bundle.settings) throw new Error('config.export did not return settings');
    const withSecret = {
      ...bundle,
      settings: { ...bundle.settings, apiToken: 'amk_should_never_travel' },
    };
    await expect(t.api(owner, production).call('config.import', { bundle: withSecret, dryRun: false })).rejects.toThrow();
    await expect(t.api(owner, production).call('config.drift', { bundle: withSecret })).rejects.toThrow();
    // The rejected import left the target workspace as it was.
    expect((await t.api(owner, production).call('workspace.get', {})).name).toBe('Portable workspace');

    // An agent token cannot apply settings: a clone is a person's decision.
    const token = (await t.api(owner, production).call('apiTokens.create', { name: 'ci', scopes: ['artifacts:write'] })).token;
    const asAgent = await rejects(
      fetch(`${t.base}/v1/config.import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-workspace-id': production },
        body: JSON.stringify({ bundle, dryRun: true }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      }),
    );
    expect(asAgent).toBeInstanceOf(Error);
  });
});
