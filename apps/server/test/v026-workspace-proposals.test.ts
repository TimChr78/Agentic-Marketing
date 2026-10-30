import { createClient } from '@agentic-marketing/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { rejects, startTestServer, testPort, type User } from './harness';

// Workspace setting proposals (#106): an agent cannot administer a workspace, but it can propose
// the name and time zone. A person with workspace:admin approves or rejects the diff.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;
let agent: ReturnType<typeof createClient<Commands>>;

const stamp = Date.now();

beforeAll(async () => {
  t = await startTestServer('test_workspace_proposals', testPort(3458));
  owner = await t.signUp(`owner-proposals-${stamp}@example.com`);
  approver = await t.signUp(`approver-proposals-${stamp}@example.com`);
  await t.workspaceWith(
    [
      [owner, 'owner'],
      [approver, 'approver'],
    ],
    'none',
  );
  const token = await t.api(owner).call('apiTokens.create', { name: 'Hermes', scopes: ['artifacts:read', 'artifacts:write'] });
  agent = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('workspace setting proposals', () => {
  it('lets an agent propose a time zone, and tells it a person must approve', async () => {
    const r = await agent.call('workspace.proposeUpdate', {
      timeZone: 'Europe/Copenhagen',
      note: 'The newsletter team and most readers are in Denmark.',
    });
    expect(r.proposalId).toMatch(/^wsp_[0-9a-f]{32}$/);
    expect(r.status).toBe('pending');
    expect(r.changes).toEqual({ timeZone: { from: 'UTC', to: 'Europe/Copenhagen' } });
    expect(r.reviewUrl).toContain(`/approvals?proposal=${r.proposalId}`);
    expect(r.next).toMatch(/person must approve/i);

    const pending = await agent.call('workspace.proposals', {});
    expect(pending.proposals).toHaveLength(1);
    expect(pending.proposals[0]).toMatchObject({
      id: r.proposalId,
      status: 'pending',
      note: 'The newsletter team and most readers are in Denmark.',
      changes: { timeZone: { from: 'UTC', to: 'Europe/Copenhagen' } },
      requester: { kind: 'token', tokenName: 'Hermes' },
    });

    // The executor audits the proposal like any other write.
    const audit = await t.api(owner).call('audit.list', { limit: 100 });
    expect(audit.entries.some((e) => e.command === 'workspace.proposeUpdate' && e.principalType === 'agent')).toBe(true);
  });

  it('does not let the agent administer the workspace or approve its own proposal', async () => {
    const proposal = (await agent.call('workspace.proposals', {})).proposals[0];
    const update = await rejects(agent.call('workspace.update', { timeZone: 'Europe/London' }));
    expect(update.status).toBe(403);
    const approve = await rejects(agent.call('workspace.approveProposal', { proposalId: proposal.id }));
    expect(approve.status).toBe(403);
    expect(approve.message).toMatch(/person/i);
  });

  it('applies the change when an admin approves, and records who decided', async () => {
    const proposal = (await agent.call('workspace.proposals', {})).proposals[0];
    const approved = await t.api(owner).call('workspace.approveProposal', { proposalId: proposal.id, note: 'Yes, we are in Copenhagen.' });
    expect(approved.status).toBe('approved');
    expect(approved.workspace.timeZone).toBe('Europe/Copenhagen');

    expect((await t.api(owner).call('workspace.get', {})).timeZone).toBe('Europe/Copenhagen');
    const decided = (await agent.call('workspace.proposals', { status: 'approved' })).proposals.find((p) => p.id === proposal.id);
    expect(decided?.decidedBy).toEqual({ id: owner.id, name: owner.email.split('@')[0] });
    expect(decided?.decisionNote).toBe('Yes, we are in Copenhagen.');
    expect(decided?.status).toBe('approved');

    const again = await rejects(t.api(owner).call('workspace.approveProposal', { proposalId: proposal.id }));
    expect(again.status).toBe(409);
  });

  it('supersedes an older pending proposal for the same setting only', async () => {
    const first = await agent.call('workspace.proposeUpdate', { timeZone: 'Europe/Berlin', note: 'Berlin first' });
    const name = await agent.call('workspace.proposeUpdate', { name: 'Pilot workspace', note: 'A clearer name' });
    const second = await agent.call('workspace.proposeUpdate', { timeZone: 'Europe/Paris', note: 'Paris is closer' });

    const superseded = (await agent.call('workspace.proposals', { status: 'superseded' })).proposals;
    expect(superseded.map((p) => p.id)).toEqual([first.proposalId]);
    const pending = (await agent.call('workspace.proposals', {})).proposals;
    expect(pending.map((p) => p.id).sort()).toEqual([name.proposalId, second.proposalId].sort());
  });

  it('requires a reason to reject, and changes nothing when rejected', async () => {
    const pending = (await agent.call('workspace.proposals', {})).proposals;
    const timeZone = pending.find((p) => p.changes.timeZone)!;
    const noNote = await rejects(t.api(owner).call('workspace.rejectProposal', { proposalId: timeZone.id, note: '' }));
    expect(noNote.status).toBe(400);

    const rejected = await t.api(owner).call('workspace.rejectProposal', { proposalId: timeZone.id, note: 'We standardise on UTC.' });
    expect(rejected).toEqual({ proposalId: timeZone.id, status: 'rejected' });
    expect((await t.api(owner).call('workspace.get', {})).timeZone).toBe('Europe/Copenhagen');

    // The name proposal was untouched by rejecting the time-zone one.
    const stillPending = (await agent.call('workspace.proposals', {})).proposals;
    expect(stillPending.map((p) => p.id)).not.toContain(timeZone.id);
    expect(stillPending).toHaveLength(1);
  });

  it('refuses an unknown time zone, an empty proposal and one that changes nothing', async () => {
    const badZone = await rejects(agent.call('workspace.proposeUpdate', { timeZone: 'Mars/Olympus', note: 'Nope' }));
    expect(badZone.status).toBe(400);
    expect(badZone.message).toMatch(/IANA/);

    const empty = await rejects(agent.call('workspace.proposeUpdate', { note: 'Nothing here' }));
    expect(empty.status).toBe(400);
    expect(empty.message).toMatch(/nothing would change/i);

    const current = (await t.api(owner).call('workspace.get', {})).timeZone;
    const noChange = await rejects(agent.call('workspace.proposeUpdate', { timeZone: current, note: 'Same again' }));
    expect(noChange.status).toBe(400);
    expect(noChange.message).toMatch(/nothing would change/i);
  });

  it('lets an approver read proposals but not decide them', async () => {
    const pending = (await agent.call('workspace.proposals', {})).proposals;
    const name = pending.find((p) => p.changes.name)!;
    expect((await t.api(approver).call('workspace.proposals', {})).proposals.map((p) => p.id)).toContain(name.id);
    const denied = await rejects(t.api(approver).call('workspace.approveProposal', { proposalId: name.id }));
    expect(denied.status).toBe(403);
    expect((await t.api(owner).call('workspace.get', {})).name).not.toBe('Pilot workspace');
  });

  it('marks a proposal approved even when the value already matches, and applies a name change', async () => {
    const pending = (await agent.call('workspace.proposals', {})).proposals;
    const name = pending.find((p) => p.changes.name)!;
    const applied = await t.api(owner).call('workspace.approveProposal', { proposalId: name.id });
    expect(applied.workspace.name).toBe('Pilot workspace');
    expect((await t.api(owner).call('workspace.get', {})).name).toBe(name.changes.name!.to);

    // A person edits the time zone directly while a proposal is pending: approving the stale
    // proposal still marks it approved, without an error.
    const stale = await agent.call('workspace.proposeUpdate', { timeZone: 'Europe/London', note: 'London time' });
    await t.api(owner).call('workspace.update', { timeZone: 'Europe/London' });
    const approved = await t.api(owner).call('workspace.approveProposal', { proposalId: stale.proposalId });
    expect(approved.status).toBe('approved');
    expect(approved.workspace.timeZone).toBe('Europe/London');
  });
});
