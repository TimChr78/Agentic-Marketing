import { dependencyOrder } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, type User } from './harness';

// Approval bundles (#107): the weekly newsletter is a new template plus the broadcast that sends
// it. Until now that took two review rounds, because a broadcast may only name a published
// template. A bundle is reviewed once and published in dependency order, all or nothing.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;
let segmentId = '';
const stamp = Date.now();

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

/** A new e-mail template and a broadcast that sends it: both drafts, nothing published. */
async function issue(n: number) {
  const api = t.api(owner);
  const template = await api.call('artifacts.create', {
    type: 'email_template',
    name: `Issue ${n}`,
    content: { purpose: 'marketing_email', subject: `Issue ${n}`, mjml: mjml(`Issue ${n} body.`) },
  });
  const broadcast = await api.call('artifacts.create', {
    type: 'broadcast',
    name: `Send issue ${n}`,
    content: { template: template.artifactId, segment: segmentId },
  });
  return { template: template.artifactId, broadcast: broadcast.artifactId };
}

beforeAll(async () => {
  t = await startTestServer('test_approval_bundles', 3457);
  owner = await t.signUp(`owner-bundles-${stamp}@example.com`);
  approver = await t.signUp(`approver-bundles-${stamp}@example.com`);
  await t.workspaceWith(
    [
      [owner, 'owner'],
      [approver, 'approver'],
    ],
    'all_publishes',
  );
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const segment = await api.call('artifacts.create', {
    type: 'segment',
    name: 'Subscribers',
    content: { condition: { consent: 'marketing_email' } },
  });
  segmentId = segment.artifactId;
  const { approvalId } = await api.call('artifacts.requestPublish', { artifactId: segmentId, note: 'audience' });
  await t.api(approver).call('approvals.approve', { approvalId: approvalId! });
});

afterAll(async () => {
  await t?.close();
});

describe('approval bundles', () => {
  it('orders members so references come first, and refuses a circle', () => {
    const order = dependencyOrder([
      { id: 'brd_1', content: { template: 'eml_1' } },
      { id: 'eml_1', content: { subject: 'x' } },
    ]);
    expect(order.map((m) => m.id)).toEqual(['eml_1', 'brd_1']);
    expect(() =>
      dependencyOrder([
        { id: 'a_1', content: { ref: 'b_1' } },
        { id: 'b_1', content: { ref: 'a_1' } },
      ]),
    ).toThrow(/circle/);
  });

  it('reviews a template and its broadcast once, and approving publishes both in order', async () => {
    const api = t.api(owner);
    const { template, broadcast } = await issue(1);
    // On its own, the broadcast still can't be submitted: its template isn't published.
    expect((await rejects(api.call('artifacts.requestPublish', { artifactId: broadcast, note: 'x' }))).message).toMatch(/not a published/);

    const r = await api.call('artifacts.requestPublishBundle', { artifactIds: [broadcast, template], note: 'Friday issue' });
    expect(r.status).toBe('in_review');
    expect(r.members.map((m) => m.artifactId)).toEqual([template, broadcast]);
    expect(r.reviewUrl).toContain(r.members[1].approvalId);

    const pending = (await api.call('approvals.list', {})).approvals.filter((a) => a.bundle?.id === r.bundleId);
    expect(pending).toHaveLength(2);
    expect(pending[0].bundle?.members.map((m) => m.artifactId)).toEqual([template, broadcast]);

    // The drawer can show the audience and send a test with the template under review.
    await expect(api.call('broadcasts.preview', { artifactId: broadcast })).rejects.toThrow(/templateVersion/);
    const reach = await api.call('broadcasts.preview', { artifactId: broadcast, templateVersion: r.members[0].version });
    expect(reach.audience).toBe(0);

    const approved = await t.api(approver).call('approvals.approve', { approvalId: r.members[1].approvalId! });
    expect(approved.published).toEqual([
      { artifactId: template, version: 1 },
      { artifactId: broadcast, version: 1 },
    ]);
    for (const id of [template, broadcast]) expect((await api.call('artifacts.get', { artifactId: id })).publishedVersion).toBe(1);
    const decided = (await api.call('approvals.list', { status: 'approved' })).approvals.filter((a) => a.bundle?.id === r.bundleId);
    expect(decided).toHaveLength(2);
  });

  it('rejecting one rejects the whole bundle', async () => {
    const api = t.api(owner);
    const { template, broadcast } = await issue(2);
    const r = await api.call('artifacts.requestPublishBundle', { artifactIds: [template, broadcast], note: 'issue 2' });
    await t.api(approver).call('approvals.reject', { approvalId: r.members[0].approvalId!, note: 'Wrong week' });
    const rejected = (await api.call('approvals.list', { status: 'rejected' })).approvals.filter((a) => a.bundle?.id === r.bundleId);
    expect(rejected).toHaveLength(2);
    for (const id of [template, broadcast]) {
      const a = await api.call('artifacts.get', { artifactId: id });
      expect(a.publishedVersion).toBeNull();
      expect(a.version.state).toBe('rejected');
    }
  });

  it('refuses a bundle that would not publish, names the artifact, and changes nothing', async () => {
    const api = t.api(owner);
    const { template, broadcast } = await issue(3);
    await api.call('artifacts.updateDraft', {
      artifactId: broadcast,
      content: { template, segment: 'seg_00000000000000000000000000000000' },
    });
    const e = await rejects(api.call('artifacts.requestPublishBundle', { artifactIds: [template, broadcast], note: 'bad' }));
    expect(e.message).toMatch(/Send issue 3/);
    expect(e.message).toMatch(/seg_00000000000000000000000000000000/);
    for (const id of [template, broadcast]) {
      const a = await api.call('artifacts.get', { artifactId: id });
      expect(a.version.state).toBe('draft');
      expect(a.publishedVersion).toBeNull();
    }
    expect((await api.call('approvals.list', {})).approvals.some((a) => a.artifactId === template)).toBe(false);
  });

  it('a person under a policy without review publishes the bundle at once', async () => {
    const api = t.api(owner);
    await api.call('workspace.setApprovalPolicy', { policy: 'none' });
    try {
      const { template, broadcast } = await issue(4);
      const r = await api.call('artifacts.requestPublishBundle', { artifactIds: [template, broadcast], note: 'issue 4' });
      expect(r.status).toBe('published');
      expect(r.bundleId).toBeNull();
      for (const id of [template, broadcast]) expect((await api.call('artifacts.get', { artifactId: id })).publishedVersion).toBe(1);
    } finally {
      await api.call('workspace.setApprovalPolicy', { policy: 'all_publishes' });
    }
  });
});
