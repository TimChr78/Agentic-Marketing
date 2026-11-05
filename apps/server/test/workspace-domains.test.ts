import { addWorkspaceDomain } from '@agentic-marketing/artifacts';
import { agentPrincipal, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, rejects, startTestServer, testPort, type User } from './harness';

// Brand domains (#186): one hostname (plus optional path prefix) per workspace, resolved before a
// workspace is known, with PUBLIC_LINKS_URL as the unchanged single-brand fallback.

const PORT = testPort(3411);
const LINKS_URL = 'https://links.example.com';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let otherOwner: User;
let member: User;
let wsA: string;
let wsB: string;
let martechId = '';
let sharedAId = '';
let sharedBId = '';

beforeAll(async () => {
  t = await startTestServer('test_workspace_domains', PORT, {
    PUBLIC_LINKS_URL: LINKS_URL,
  });
  owner = await t.signUp(`domains-owner-${Date.now()}@example.com`);
  otherOwner = await t.signUp(`domains-other-${Date.now()}@example.com`);
  member = await t.signUp(`domains-member-${Date.now()}@example.com`);
  // `member` administers A and is only a marketer in B; `owner` belongs only to A.
  wsA = await t.workspaceWith([
    [owner, 'owner'],
    [member, 'admin'],
  ]);
  wsB = await t.workspaceWith([
    [otherOwner, 'owner'],
    [member, 'marketer'],
  ]);
}, 120_000);

afterAll(() => t?.close());

describe('brand domains', () => {
  it('keeps a workspace without a domain on PUBLIC_LINKS_URL', async () => {
    const got = await t.api(owner, wsA).call('workspace.get', {});
    expect(got.domains).toEqual([]);
    expect(got.linksUrl).toBe(LINKS_URL);
    expect((await t.api(owner, wsA).call('workspace.domains.list', {})).linksUrl).toBe(LINKS_URL);
  });

  it('registers two domains for two workspaces and resolves each by Host and path once verified', async () => {
    const a = await t.api(owner, wsA).call('workspace.domains.add', { host: 'MartechSignal.COM', isPrimary: true });
    martechId = a.domain.id;
    expect(a.domain).toMatchObject({
      host: 'martechsignal.com',
      pathPrefix: null,
      isPrimary: true,
      status: 'pending',
      url: 'https://martechsignal.com',
    });

    const b = await t.api(otherOwner, wsB).call('workspace.domains.add', {
      host: 'https://second.example/',
      pathPrefix: 'am/',
      isPrimary: true,
    });
    expect(b.domain).toMatchObject({
      host: 'second.example',
      pathPrefix: '/am',
      isPrimary: true,
      url: 'https://second.example/am',
    });

    // Only a verified domain is a brand host: pending rows are listed but inactive (#185).
    expect(await t.srv.domains.resolveWorkspaceForRequest('MartechSignal.com:443', '/u/abc')).toBeNull();
    expect(await t.srv.domains.resolveWorkspaceForRequest('second.example', '/am/f/form')).toBeNull();
    expect((await t.api(owner, wsA).call('workspace.get', {})).linksUrl).toBe(LINKS_URL);

    // Verification fetches the challenge the public listener serves; the test replaces the fetch.
    const fetched: string[] = [];
    t.srv.services.fetchDomainChallenge = async (url) => {
      fetched.push(url);
      return { status: 200, body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') };
    };
    const verifiedA = await t.api(owner, wsA).call('workspace.domains.verify', { id: martechId });
    expect(verifiedA.domain.status).toBe('verified');
    expect(verifiedA.domain.verifiedAt).not.toBeNull();
    expect(fetched[0]).toBe(`https://martechsignal.com/.well-known/am-domain/${verifiedA.domain.verificationToken}`);
    await t.api(otherOwner, wsB).call('workspace.domains.verify', { id: b.domain.id });

    // The first lookup may have cached an empty registry; the writes must invalidate it.
    const hitA = await t.srv.domains.resolveWorkspaceForRequest('MartechSignal.com:443', '/u/abc');
    expect(hitA?.domain.workspaceId).toBe(wsA);
    expect(hitA?.matchedPrefix).toBeNull();

    const hitB = await t.srv.domains.resolveWorkspaceForRequest('second.example', '/am/f/form');
    expect(hitB?.domain.workspaceId).toBe(wsB);
    expect(hitB?.matchedPrefix).toBe('/am');

    expect(await t.srv.domains.resolveWorkspaceForRequest('second.example', '/am2/f/form')).toBeNull();
    expect(await t.srv.domains.resolveWorkspaceForRequest('unknown.example', '/f/form')).toBeNull();
    expect(await t.srv.domains.resolveWorkspaceForRequest('*.example.com', '/f/form')).toBeNull();
  });

  it('shows the primary domain as the effective links URL', async () => {
    expect((await t.api(owner, wsA).call('workspace.get', {})).linksUrl).toBe('https://martechsignal.com');
    expect((await t.api(owner, wsA).call('workspace.domains.list', {})).linksUrl).toBe('https://martechsignal.com');
    expect((await t.api(otherOwner, wsB).call('workspace.get', {})).linksUrl).toBe('https://second.example/am');
    expect((await t.api(otherOwner, wsB).call('workspace.domains.list', {})).linksUrl).toBe('https://second.example/am');
    expect(await t.srv.services.linksUrlFor?.(wsA)).toBe('https://martechsignal.com');
    expect(await t.srv.domains.linksUrlFor(wsB)).toBe('https://second.example/am');
  });

  it('lets the longest path prefix win on a shared host', async () => {
    const a = await t.api(owner, wsA).call('workspace.domains.add', { host: 'shared.example', pathPrefix: '/am' });
    sharedAId = a.domain.id;
    const b = await t.api(otherOwner, wsB).call('workspace.domains.add', { host: 'shared.example', pathPrefix: '/am2' });
    sharedBId = b.domain.id;
    expect(await t.srv.domains.resolveWorkspaceForRequest('shared.example', '/am/f/form')).toBeNull();
    await t.api(owner, wsA).call('workspace.domains.verify', { id: sharedAId });
    await t.api(otherOwner, wsB).call('workspace.domains.verify', { id: sharedBId });

    expect((await t.srv.domains.resolveWorkspaceForRequest('shared.example', '/am/f/form'))?.domain.workspaceId).toBe(wsA);
    expect((await t.srv.domains.resolveWorkspaceForRequest('shared.example', '/am2/f/form'))?.domain.workspaceId).toBe(wsB);
    expect(await t.srv.domains.resolveWorkspaceForRequest('shared.example', '/f/form')).toBeNull();
  });

  it('rejects a duplicate host and prefix, across workspaces too', async () => {
    const duplicate = await rejects(t.api(otherOwner, wsB).call('workspace.domains.add', { host: 'martechsignal.com' }));
    expect(duplicate.status).toBe(400);
    expect(duplicate.message).toMatch(/already registered/i);

    const samePrefix = await rejects(t.api(owner, wsA).call('workspace.domains.add', { host: 'shared.example', pathPrefix: '/am2' }));
    expect(samePrefix.status).toBe(400);
    expect(samePrefix.message).toMatch(/already registered/i);
  });

  it('rejects a second primary domain', async () => {
    const err = await rejects(t.api(owner, wsA).call('workspace.domains.add', { host: 'another.example', isPrimary: true }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/primary domain/i);

    const promote = await rejects(t.api(owner, wsA).call('workspace.domains.update', { id: sharedAId, isPrimary: true }));
    expect(promote.status).toBe(400);
    expect(promote.message).toMatch(/primary domain/i);
  });

  it('validates hosts and prefixes at write time', async () => {
    const wildcard = await rejects(t.api(owner, wsA).call('workspace.domains.add', { host: '*.example.com' }));
    expect(wildcard.status).toBe(400);
    expect(wildcard.message).toMatch(/wildcard/i);

    const scheme = await rejects(t.api(owner, wsA).call('workspace.domains.add', { host: 'http://plain.example' }));
    expect(scheme.status).toBe(400);
    expect(scheme.message).toMatch(/https/i);

    const traversal = await rejects(t.api(owner, wsA).call('workspace.domains.add', { host: 'safe.example', pathPrefix: '/am/../admin' }));
    expect(traversal.status).toBe(400);
    expect(traversal.message).toMatch(/\.\./);
  });

  it('refuses a verification answer that is not the domain token', async () => {
    const added = await t.api(owner, wsA).call('workspace.domains.add', { host: 'wrong-answer.example' });
    t.srv.services.fetchDomainChallenge = async () => ({ status: 200, body: 'some-other-site' });
    const err = await rejects(t.api(owner, wsA).call('workspace.domains.verify', { id: added.domain.id }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('did not return this domain');
    expect(
      (await t.api(owner, wsA).call('workspace.domains.list', {})).domains.find((d: { id: string }) => d.id === added.domain.id),
    ).toMatchObject({ status: 'pending' });
    expect(await t.srv.domains.resolveWorkspaceForRequest('wrong-answer.example', '/f/x')).toBeNull();
  });

  it('updates a domain, resetting verification when the host moves', async () => {
    t.srv.services.fetchDomainChallenge = async (url) => ({
      status: 200,
      body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
    });
    const verified = await t.api(owner, wsA).call('workspace.domains.verify', { id: sharedAId });
    expect(verified.domain.status).toBe('verified');
    expect(verified.domain.verifiedAt).not.toBeNull();
    const token = verified.domain.verificationToken;

    const moved = await t.api(owner, wsA).call('workspace.domains.update', {
      id: sharedAId,
      host: 'shared-two.example',
    });
    expect(moved.domain).toMatchObject({ host: 'shared-two.example', pathPrefix: '/am', status: 'pending', verifiedAt: null });
    expect(moved.domain.verificationToken).not.toBe(token);
    expect(await t.srv.domains.resolveWorkspaceForRequest('shared-two.example', '/am/f/x')).toBeNull();
    await t.api(owner, wsA).call('workspace.domains.verify', { id: sharedAId });
    expect((await t.srv.domains.resolveWorkspaceForRequest('shared-two.example', '/am/f/x'))?.domain.workspaceId).toBe(wsA);
  });

  it('falls back to PUBLIC_LINKS_URL after the primary is removed', async () => {
    await t.api(owner, wsA).call('workspace.domains.remove', { id: martechId });
    const got = await t.api(owner, wsA).call('workspace.get', {});
    expect(got.linksUrl).toBe(LINKS_URL);
    expect(got.domains.some((domain: { id: string }) => domain.id === martechId)).toBe(false);
    expect(await t.srv.domains.resolveWorkspaceForRequest('martechsignal.com', '/u/x')).toBeNull();
  });

  it('does not let a member of A edit B, and hides B’s rows under RLS', async () => {
    const notAdmin = await rejects(t.api(member, wsB).call('workspace.domains.add', { host: 'b-only.example' }));
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.message).toMatch(/workspace:admin/);

    const outsider = await rejects(t.api(owner, wsB).call('workspace.domains.add', { host: 'b-only.example' }));
    expect([401, 403]).toContain(outsider.status);

    // A row id from B is invisible with A's tenant setting: the command answers not found.
    const hidden = await rejects(t.api(owner, wsA).call('workspace.domains.update', { id: sharedBId, host: 'stolen.example' }));
    expect(hidden.status).toBe(404);

    const visible = await t.srv.db.withWorkspace(wsA, (tx) => tx.select({ id: schema.workspaceDomains.id }).from(schema.workspaceDomains));
    const ids = visible.map((row) => row.id);
    expect(ids).toContain(sharedAId);
    expect(ids).not.toContain(sharedBId);
  });

  it('keeps the commands people-only for an agent token', async () => {
    const agent = agentPrincipal(owner.id, 'test-client', wsA, 'owner', ['workspace:admin', 'artifacts:read']);
    const err = await rejects(t.srv.executor.execute(addWorkspaceDomain, { host: 'agent.example' }, agent, { surface: 'mcp' }));
    expect(err.status).toBe(403);
    expect(err.message).toContain('can only be run by a person');

    const connected = await connectAgent(t.base, owner, [...ROLE_PERMISSIONS.owner]);
    try {
      const names = (await connected.client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain('workspace.domains.add');
      expect(names).not.toContain('workspace.domains.list');
      expect(names).not.toContain('workspace.domains.verify');
    } finally {
      await connected.client.close();
    }
  });

  it('audits adds, updates, removes and the list read', async () => {
    const { entries } = await t.api(owner, wsA).call('audit.list', { limit: 200 });
    for (const command of [
      'workspace.domains.add',
      'workspace.domains.update',
      'workspace.domains.verify',
      'workspace.domains.remove',
      'workspace.domains.list',
    ])
      expect(
        entries.some((entry: { command: string; ok: boolean }) => entry.command === command && entry.ok),
        command,
      ).toBe(true);
  });
});
