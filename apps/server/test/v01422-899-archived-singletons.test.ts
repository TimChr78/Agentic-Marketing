import { type ArtifactType, artifactTypes, publishedSingleton } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #899: migration 0092 archives duplicate singleton rows and stamps them with `updated_at = now()`.
// Every reader of a singleton must therefore exclude archived rows: a reader that only orders by
// `updated_at desc` otherwise serves the dead duplicate's published content after an upgrade.

type SingletonType = 'brand' | 'business_context' | 'tracking_plan' | 'purposes' | 'conversion_map' | 'delivery_policy';

const SINGLETONS: SingletonType[] = ['brand', 'business_context', 'tracking_plan', 'purposes', 'conversion_map', 'delivery_policy'];

const ACTIVE_CONTENT: Record<SingletonType, unknown> = {
  brand: { siteName: 'Active brand' },
  business_context: { summary: 'The active brief.' },
  tracking_plan: { unknownEvents: 'allow' },
  purposes: { purposes: [{ key: 'marketing_email', name: 'Marketing', basis: 'consent', channels: ['email'] }] },
  conversion_map: { rules: [{ event: 'Order Completed' }] },
  delivery_policy: { timezone: 'UTC' },
};

const ARCHIVED_CONTENT: Record<SingletonType, unknown> = {
  brand: { siteName: 'Archived duplicate brand' },
  business_context: { summary: 'The archived brief.' },
  tracking_plan: { unknownEvents: 'block' },
  purposes: { purposes: [{ key: 'archived_purpose', name: 'Archived', basis: 'consent', channels: ['web'] }] },
  conversion_map: { rules: [{ event: 'Archived Event' }] },
  delivery_policy: { timezone: 'Europe/Copenhagen' },
};

const ACTIVE_MARKER: Record<SingletonType, string> = {
  brand: 'Active brand',
  business_context: 'The active brief.',
  tracking_plan: '"unknownEvents":"allow"',
  purposes: '"key":"marketing_email"',
  conversion_map: 'Order Completed',
  delivery_policy: '"timezone":"UTC"',
};

const ARCHIVED_MARKER: Record<SingletonType, string> = {
  brand: 'Archived duplicate brand',
  business_context: 'The archived brief.',
  tracking_plan: '"unknownEvents":"block"',
  purposes: '"key":"archived_purpose"',
  conversion_map: 'Archived Event',
  delivery_policy: '"timezone":"Europe/Copenhagen"',
};

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01422_899', testPort(4460));
  owner = await t.signUp(`owner-v01422-899-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

/** One artifact row with one published version, as the readers see it. */
async function seedPublished(ws: string, type: SingletonType, content: unknown, opts: { archived: boolean; updatedMinutesAgo: number }) {
  const id = newId(artifactTypes[type as ArtifactType].prefix);
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, archived, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, 1, $5, now() - interval '1 day', now() - make_interval(mins => $6))`,
    [ws, id, type, `${opts.archived ? 'Archived' : 'Active'} ${type}`, opts.archived, opts.updatedMinutesAgo],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', $5)`,
    [ws, id, content, `hash-${id}`, owner.id],
  );
  return id;
}

/** Every singleton type with an active published row and an archived published duplicate that is newer. */
async function seedAll(ws: string) {
  const active = new Map<SingletonType, string>();
  for (const type of SINGLETONS) {
    active.set(type, await seedPublished(ws, type, ACTIVE_CONTENT[type], { archived: false, updatedMinutesAgo: 60 }));
    await seedPublished(ws, type, ARCHIVED_CONTENT[type], { archived: true, updatedMinutesAgo: 0 });
  }
  return active;
}

const readPublished = (ws: string, type: SingletonType) =>
  t.srv.db.withWorkspace(ws, (tx) => publishedSingleton(tx, type)) as Promise<Record<string, unknown> | null>;

describe('singleton readers skip the archived duplicate (#899)', () => {
  it('publishedSingleton reads the active row, never the newer archived one', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    await seedAll(ws);
    for (const type of SINGLETONS) {
      const content = await readPublished(ws, type);
      const text = JSON.stringify(content);
      expect(text, type).toContain(ACTIVE_MARKER[type]);
      expect(text, type).not.toContain(ARCHIVED_MARKER[type]);
    }
  });

  it('workspace.get reads the active brand', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    await seedAll(ws);
    const out = await t.api(owner, ws).call('workspace.get', {});
    expect(out.brand.siteName).toBe('Active brand');
  });

  it('workspace.businessContext (the business-context://current resource) reads the active brief', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    await seedAll(ws);
    const out = await t.api(owner, ws).call('workspace.businessContext', {});
    expect(out.content).toMatchObject({ summary: 'The active brief.' });
    expect(out.version).toBe(1);
  });

  it('workspace.memberships shows the active brand in the switcher', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    await seedAll(ws);
    const out = await t.api(owner, ws).call('workspace.memberships', {});
    const mine = out.workspaces.find((w) => w.id === ws);
    expect(mine?.brand.siteName).toBe('Active brand');
  });

  it('hosted pages render the active brand', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    await seedAll(ws);
    const out = await t.api(owner, ws).call('hostedPages.preview', { page: 'confirmed' });
    expect(out.html).toContain('Active brand');
    expect(out.html).not.toContain('Archived duplicate brand');
  });

  it('config.drift resolves the active singleton as the current one', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const active = await seedAll(ws);
    const out = await t.api(owner, ws).call('config.drift', {
      bundle: {
        format: 'agentic-marketing/artifacts@1',
        artifacts: [{ id: newId('brd'), type: 'brand', name: 'Imported brand', content: { siteName: 'Active brand' } }],
      },
    });
    // The archived duplicate has different content; without the filter the plan would compare
    // against it. The active brand is what the workspace has, so this is an update to that row.
    expect(out.drift).toMatchObject([{ kind: 'artifact', key: active.get('brand'), type: 'brand', status: 'update' }]);
    expect(JSON.stringify(out)).not.toContain('Archived duplicate brand');
  });
});
