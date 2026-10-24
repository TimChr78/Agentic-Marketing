import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Pilot 0.1.2 (#46): a draft newsletter can be test-sent to the people doing the work without
// going through purpose/consent checks, but only to workspace members or an admin's seed list,
// always marked as a test in the message log and the audit trail.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let marketer: User;
let draftTemplate = '';
let seedTemplate = '';

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const mailTo = (to: string) => outbox.filter((m) => m.to === to);

beforeAll(async () => {
  t = await startTestServer('test_pilot_testsend', 3311);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  marketer = await t.signUp(`marketer-${Date.now()}@example.com`);
  await t.workspaceWith([
    [owner, 'owner'],
    [marketer, 'marketer'],
  ]);
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const draft = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Draft issue',
    content: {
      purpose: 'marketing_email',
      subject: 'Hello {{ profile.firstName | default: "there" }}',
      mjml: mjml('Hi {{ profile.firstName | default: "there" }}, this is the draft.'),
    },
  });
  draftTemplate = draft.artifactId;
  const seed = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Seed issue',
    content: {
      purpose: 'marketing_email',
      subject: 'Seed {{ profile.firstName | default: "reader" }}',
      mjml: mjml('Seed copy for {{ profile.firstName | default: "reader" }}.'),
    },
  });
  seedTemplate = seed.artifactId;
}, 60_000);

afterAll(() => t?.close());

describe('test-sending a draft template', () => {
  it('sends the latest draft to a member, marks the message and audits it', async () => {
    const api = t.api(owner);
    const result = await api.call('templates.sendTest', { artifactId: draftTemplate, to: [owner.email] });
    expect(result).toMatchObject({ to: owner.email, subject: '[Test] Hello there', provider: 'Outbox' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ email: owner.email, status: 'sent', subject: '[Test] Hello there' });

    const mail = await eventually(
      async () => mailTo(owner.email).filter((m) => m.subject === '[Test] Hello there'),
      (m) => m.length === 1,
    );
    expect(mail).toHaveLength(1);
    // The unsubscribe link in a test is inert (the /u/ route rejects an unsigned token).
    expect(mail[0].html).toContain('/u/test');

    const { messages } = await eventually(
      () => api.call('messages.list', { limit: 100 }),
      (r) => r.messages.some((m) => m.id === result.messages[0].messageId),
    );
    expect(messages.find((m) => m.id === result.messages[0].messageId)).toMatchObject({
      test: true,
      templateId: draftTemplate,
      templateVersion: 1,
      status: 'sent',
      profileId: null,
    });

    const { entries } = await api.call('audit.list', { limit: 100 });
    expect(entries.some((e) => e.command === 'templates.sendTest' && e.target === draftTemplate && e.ok)).toBe(true);
  });

  it('refuses an address that is neither a member nor on the seed list', async () => {
    const api = t.api(owner);
    const err = await rejects(api.call('templates.sendTest', { artifactId: draftTemplate, to: ['stranger@example.com'] }));
    expect(err.message).toContain('stranger@example.com');
    expect(err.message).toContain('members of this workspace');
    expect(mailTo('stranger@example.com')).toHaveLength(0);
  });

  it('accepts an admin’s seed address and does not create a profile for it', async () => {
    const api = t.api(owner);
    const seed = 'monitor-seed@example.com';
    expect(await api.call('workspace.setSeedList', { seedList: [seed] })).toEqual({ seedList: [seed] });
    expect((await api.call('workspace.get', {})).seedList).toEqual([seed]);

    const result = await api.call('templates.sendTest', { artifactId: seedTemplate, to: [seed] });
    expect(result).toMatchObject({ to: seed, subject: '[Test] Seed reader', provider: 'Outbox' });
    await eventually(
      async () => mailTo(seed).filter((m) => m.subject === '[Test] Seed reader'),
      (m) => m.length === 1,
    );
    expect((await api.call('profiles.find', { type: 'email', value: seed })).profileId).toBeNull();
  });

  it('does not let a non-admin change the seed list', async () => {
    const err = await rejects(t.api(marketer).call('workspace.setSeedList', { seedList: ['someone@example.com'] }));
    expect(err.message).toContain('workspace:admin');
    expect((await t.api(owner).call('workspace.get', {})).seedList).toEqual(['monitor-seed@example.com']);
  });
});

describe('test-sending a broadcast', () => {
  it('renders the broadcast’s template at the version the broadcast would send', async () => {
    const api = t.api(owner);
    const segment = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Newsletter subscribers',
      content: { condition: { consent: 'marketing_email' } },
    });
    await api.call('artifacts.requestPublish', { artifactId: segment.artifactId, note: 'x' });

    const first = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'First issue',
      content: { purpose: 'marketing_email', subject: 'First issue', mjml: mjml('First issue body') },
    });
    await api.call('artifacts.requestPublish', { artifactId: first.artifactId, note: 'x' });
    // A newer template draft is not what a published broadcast would send.
    await api.call('artifacts.updateDraft', {
      artifactId: first.artifactId,
      content: { purpose: 'marketing_email', subject: 'First issue (unpublished)', mjml: mjml('First issue draft body') },
    });
    const second = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Second issue',
      content: { purpose: 'marketing_email', subject: 'Second issue', mjml: mjml('Second issue body') },
    });
    await api.call('artifacts.requestPublish', { artifactId: second.artifactId, note: 'x' });

    const broadcast = await api.call('artifacts.create', {
      type: 'broadcast',
      name: 'Weekly',
      content: { template: first.artifactId, segment: segment.artifactId },
    });
    const before = await api.call('broadcasts.sendTest', { artifactId: broadcast.artifactId, to: [owner.email] });
    expect(before).toMatchObject({ subject: '[Test] First issue', provider: 'Outbox' });

    // The latest broadcast draft now points at another template.
    await api.call('artifacts.updateDraft', {
      artifactId: broadcast.artifactId,
      content: { template: second.artifactId, segment: segment.artifactId },
    });
    const after = await api.call('broadcasts.sendTest', { artifactId: broadcast.artifactId, to: [owner.email] });
    expect(after).toMatchObject({ subject: '[Test] Second issue', provider: 'Outbox' });
    await eventually(
      async () => mailTo(owner.email).filter((m) => m.subject.startsWith('[Test] Second issue')),
      (m) => m.length >= 1,
    );

    // Before the first approval round the template has no published version: the test uses its draft.
    const third = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Third issue',
      content: { purpose: 'marketing_email', subject: 'Third issue draft', mjml: mjml('Third issue body') },
    });
    await api.call('artifacts.updateDraft', {
      artifactId: broadcast.artifactId,
      content: { template: third.artifactId, segment: segment.artifactId },
    });
    const unpublished = await api.call('broadcasts.sendTest', { artifactId: broadcast.artifactId, to: [owner.email] });
    expect(unpublished).toMatchObject({ subject: '[Test] Third issue draft', provider: 'Outbox' });

    const { entries } = await api.call('audit.list', { limit: 100 });
    expect(entries.some((e) => e.command === 'broadcasts.sendTest' && e.target === broadcast.artifactId && e.ok)).toBe(true);
  });
});
