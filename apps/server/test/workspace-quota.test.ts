import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// #487: workspace.create's only gate was owning one brand, so one owner could create unbounded
// brands (and pending domain claims). WORKSPACE_QUOTA bounds the owner memberships a person may
// have; the refusal happens before anything is written.

const PORT = testPort(3595);
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let other: User;
let wsA = '';
let wsOther = '';

beforeAll(async () => {
  t = await startTestServer('test_workspace_quota', PORT, { WORKSPACE_QUOTA: '2' });
  const stamp = Date.now();
  owner = await t.signUp(`quota-owner-${stamp}@example.com`);
  other = await t.signUp(`quota-other-${stamp}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']]);
  wsOther = await t.workspaceWith([[other, 'owner']]);
}, 120_000);
afterAll(() => t?.close());

const ownedCount = async (user: User) => {
  const { rows } = await t.srv.db.admin.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM workspace_members WHERE user_id = $1 AND role = 'owner'",
    [user.id],
  );
  return Number(rows[0].n);
};

describe('workspace.create quota (#487)', () => {
  it('allows the brands up to the configured limit and refuses the next with the limit named', async () => {
    const second = await t.api(owner, wsA).call('workspace.create', { name: 'Second brand' });
    expect(second.workspaceId).toBeTruthy();
    expect(await ownedCount(owner)).toBe(2);

    const before = await t.srv.db.admin.query<{ workspaces: string; domains: string; memberships: string }>(
      `SELECT (SELECT count(*) FROM workspaces)::text AS workspaces,
              (SELECT count(*) FROM workspace_domains)::text AS domains,
              (SELECT count(*) FROM workspace_members)::text AS memberships`,
    );
    const refused = await rejects(t.api(owner, wsA).call('workspace.create', { name: 'Third brand', primaryDomain: 'third.example' }));
    expect(refused.status).toBe(403);
    expect(refused.message).toContain('limit for one person is 2');
    expect(refused.message).toContain('WORKSPACE_QUOTA');
    // Nothing was written: no workspace, no owner membership, no pending domain. The refusal
    // itself is audited, as every failed command is.
    const after = await t.srv.db.admin.query<{ workspaces: string; domains: string; memberships: string }>(
      `SELECT (SELECT count(*) FROM workspaces)::text AS workspaces,
              (SELECT count(*) FROM workspace_domains)::text AS domains,
              (SELECT count(*) FROM workspace_members)::text AS memberships`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await ownedCount(owner)).toBe(2);
    const leftover = await t.srv.db.admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM workspaces WHERE name = 'Third brand'",
    );
    expect(leftover.rows[0].n).toBe('0');
  });

  it('counts owner memberships only, so another person’s brands do not use the quota', async () => {
    const created = await t.api(other, wsOther).call('workspace.create', { name: 'Other brand' });
    expect(created.workspaceId).toBeTruthy();
    expect(await ownedCount(other)).toBe(2);
    // The owner is still at their own limit, independent of the other person's creations.
    const refused = await rejects(t.api(owner, wsA).call('workspace.create', { name: 'Owner again' }));
    expect(refused.status).toBe(403);
  });
});
