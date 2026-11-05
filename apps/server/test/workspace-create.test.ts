import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// #190: a person who owns a brand may create another from the admin UI. A brand is a workspace,
// so the call writes the workspace (with the bootstrap defaults), the owner membership, a draft
// brand artifact and a pending primary domain in one transaction. Agents and tokens never can.

const PORT = testPort(3597);
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let admin: User;
let marketer: User;
let wsA = '';
let token = '';

const rest = (value: string, name: string, body: unknown) =>
  fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${value}` },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  t = await startTestServer('test_workspace_create', PORT, { PUBLIC_LINKS_URL: 'https://links.example' });
  const stamp = Date.now();
  owner = await t.signUp(`brand-owner-${stamp}@example.com`);
  admin = await t.signUp(`brand-admin-${stamp}@example.com`);
  marketer = await t.signUp(`brand-marketer-${stamp}@example.com`);
  wsA = await t.workspaceWith([
    [owner, 'owner'],
    [admin, 'admin'],
    [marketer, 'marketer'],
  ]);
  token = (await t.api(owner, wsA).call('apiTokens.create', { name: 'brand maker', scopes: ['artifacts:read', 'artifacts:write'] })).token;
}, 120_000);

afterAll(() => t?.close());

describe('workspace.create (#190)', () => {
  it('creates a brand with a pending primary domain, owner membership and draft brand artifact', async () => {
    const created = await t.api(owner, wsA).call('workspace.create', {
      name: 'Second brand',
      primaryDomain: 'Second.Example',
      pathPrefix: '/am/',
      siteName: 'Second',
      logoUrl: 'https://cdn.example/logo.svg',
    });
    expect(created).toMatchObject({
      name: 'Second brand',
      brand: { siteName: 'Second', logoUrl: 'https://cdn.example/logo.svg', primaryDomain: 'second.example' },
      domain: { host: 'second.example', pathPrefix: '/am', isPrimary: true, status: 'pending' },
    });
    expect(created.workspaceId).toMatch(/^[0-9a-f-]{36}$/);

    const brand = await t.api(owner, created.workspaceId).call('workspace.get', {});
    expect(brand.name).toBe('Second brand');
    expect(brand.you.role).toBe('owner');
    expect(brand.domains).toHaveLength(1);
    expect(brand.domains[0]).toMatchObject({ host: 'second.example', status: 'pending', isPrimary: true });
    // A pending domain does not supply links yet, and a draft brand artifact is not public.
    expect(brand.linksUrl).toBe('https://links.example');
    expect(brand.brand).toEqual({ siteName: 'Second brand', logoUrl: null, primaryDomain: 'second.example' });

    // The draft artifact and the membership are there, as the workspace creation promise says.
    const { rows } = await t.srv.db.admin.query<{ type: string; state: string; role: string }>(
      `SELECT a.type, v.state, m.role
         FROM artifacts a
         JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = 1
         JOIN workspace_members m ON m.workspace_id = a.workspace_id AND m.user_id = $2
        WHERE a.workspace_id = $1 AND a.type = 'brand'`,
      [created.workspaceId, owner.id],
    );
    expect(rows).toEqual([{ type: 'brand', state: 'draft', role: 'owner' }]);

    // The create is audited in the caller's brand, with the new workspace as the target.
    const audit = await t.srv.db.admin.query<{ command: string; target: string; ok: boolean }>(
      'SELECT command, target, ok FROM audit_log WHERE workspace_id = $1 AND command = $2 ORDER BY seq DESC LIMIT 1',
      [wsA, 'workspace.create'],
    );
    expect(audit.rows[0]).toMatchObject({ command: 'workspace.create', target: created.workspaceId, ok: true });
  });

  it('shows the published brand summary in workspace.get and workspace.memberships', async () => {
    const draft = await t.api(owner, wsA).call('artifacts.create', {
      type: 'brand',
      name: 'Brand',
      content: { siteName: 'Martech Signal', logoUrl: 'https://cdn.example/martech.svg' },
    });
    await t.api(owner, wsA).call('artifacts.requestPublish', { artifactId: draft.artifactId, note: 'Initial brand' });

    const got = await t.api(owner, wsA).call('workspace.get', {});
    expect(got.brand).toEqual({ siteName: 'Martech Signal', logoUrl: 'https://cdn.example/martech.svg', primaryDomain: null });

    const memberships = await t.api(owner, wsA).call('workspace.memberships', {});
    const mine = memberships.workspaces.find((workspace) => workspace.id === wsA);
    expect(mine).toMatchObject({
      name: expect.any(String),
      role: 'owner',
      brand: { siteName: 'Martech Signal', logoUrl: 'https://cdn.example/martech.svg', primaryDomain: null },
    });
    // A brand without a published artifact falls back to the workspace name, not another brand's.
    const second = memberships.workspaces.find((workspace) => workspace.name === 'Second brand');
    expect(second?.brand.siteName).toBe('Second brand');
  });

  it('refuses people who do not own a brand, and API tokens', async () => {
    const asAdmin = await rejects(t.api(admin, wsA).call('workspace.create', { name: 'Admin brand' }));
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.message).toMatch(/owns a brand/i);

    const asMarketer = await rejects(t.api(marketer, wsA).call('workspace.create', { name: 'Marketer brand' }));
    expect(asMarketer.status).toBe(403);

    const asToken = await rest(token, 'workspace.create', { name: 'Token brand' });
    expect(asToken.status).toBe(403);
    expect(await asToken.text()).toMatch(/people|agent/i);
  });

  it('leaves nothing behind when the domain is already registered', async () => {
    const before = await t.srv.db.admin.query<{ workspaces: string; memberships: string; brands: string; domains: string }>(
      `SELECT
         (SELECT count(*) FROM workspaces)::text AS workspaces,
         (SELECT count(*) FROM workspace_members WHERE user_id = $1)::text AS memberships,
         (SELECT count(*) FROM artifacts WHERE type = 'brand')::text AS brands,
         (SELECT count(*) FROM workspace_domains)::text AS domains`,
      [owner.id],
    );
    const duplicate = await rejects(
      t.api(owner, wsA).call('workspace.create', { name: 'Duplicate brand', primaryDomain: 'second.example', pathPrefix: '/am' }),
    );
    expect(duplicate.status).toBe(400);
    expect(duplicate.message).toMatch(/already registered/i);
    const after = await t.srv.db.admin.query<{ workspaces: string; memberships: string; brands: string; domains: string }>(
      `SELECT
         (SELECT count(*) FROM workspaces)::text AS workspaces,
         (SELECT count(*) FROM workspace_members WHERE user_id = $1)::text AS memberships,
         (SELECT count(*) FROM artifacts WHERE type = 'brand')::text AS brands,
         (SELECT count(*) FROM workspace_domains)::text AS domains`,
      [owner.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const leftover = await t.srv.db.admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspaces WHERE name = 'Duplicate brand'",
    );
    expect(leftover.rows[0].count).toBe('0');
  });
});
