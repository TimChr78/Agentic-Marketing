import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, type User } from './harness';

// Reusable e-mail blocks (#73): a versioned MJML fragment with typed parameters, included in a
// template as {% block 'blk_…', key: value %}. The published block is inlined before MJML
// compilation; html parameters go in raw, everything else is escaped.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
const stamp = Date.now();

const frame = (body: string) =>
  `<mjml><mj-body>${body}<mj-section><mj-column><mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

/** A header block with a text title, an optional html body and an image. */
const header = () => ({
  description: 'Weekly header',
  category: 'header' as const,
  mjml: `<mj-section><mj-column>
    <mj-text font-size="22px">{{ block.title }}</mj-text>
    <mj-text>{{ block.body }}</mj-text>
    <mj-image src="{{ block.image }}" alt="{{ block.title }}" />
  </mj-column></mj-section>`,
  params: [
    { key: 'title', label: 'Title', type: 'text' as const, required: true },
    { key: 'body', label: 'Body', type: 'html' as const, default: '<p>Default body</p>' },
    { key: 'image', label: 'Image', type: 'image' as const, default: 'https://example.com/logo.png' },
  ],
});

beforeAll(async () => {
  t = await startTestServer('test_blocks73', 3462);
  owner = await t.signUp(`owner-blocks-${stamp}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
});

afterAll(async () => {
  await t?.close();
});

describe('reusable e-mail blocks', () => {
  it('renders a published block inside a template, escaping text and inserting html raw', async () => {
    const api = t.api(owner);
    const created = await api.call('artifacts.create', { type: 'email_block', name: 'Weekly header', content: header() });
    const id = created.artifactId;
    await api.call('artifacts.requestPublish', { artifactId: id, note: 'first header' });

    const template = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Issue with header',
      content: {
        purpose: 'marketing_email',
        subject: 'This week',
        mjml: frame(`{% block '${id}', title: profile.firstName, body: '<strong>Hi there</strong>' %}`),
      },
    });

    const preview = await api.call('templates.preview', {
      artifactId: template.artifactId,
      data: { profile: { firstName: '<script>alert(1)</script>' } },
    });
    expect(preview.html).not.toContain('<script>alert(1)');
    expect(preview.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(preview.html).toContain('<strong>Hi there</strong>');
    expect(preview.html).toContain('https://example.com/logo.png');

    // artifacts.get exposes the reference so a reviewer can see which block the template uses.
    expect((await api.call('artifacts.get', { artifactId: template.artifactId })).references).toEqual([id]);
  });

  it('renders a block from blocks.preview with defaults and overrides', async () => {
    const api = t.api(owner);
    const created = await api.call('artifacts.create', { type: 'email_block', name: 'Preview header', content: header() });
    const withDefaults = await api.call('blocks.preview', { artifactId: created.artifactId });
    expect(withDefaults.html).toContain('Sample text');
    expect(withDefaults.html).toContain('Default body');
    const overridden = await api.call('blocks.preview', {
      artifactId: created.artifactId,
      params: { title: 'Hello', image: '/a/ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo.png' },
    });
    expect(overridden.html).toContain('Hello');
    expect(overridden.html).toContain('/a/ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo.png');
    await expect(api.call('blocks.preview', { artifactId: created.artifactId, params: { image: 'javascript:alert(1)' } })).rejects.toThrow(
      /http\(s\) or asset URL/,
    );
  });

  it('refuses a template whose block is not published, then publishes a new block and template as one bundle', async () => {
    const api = t.api(owner);
    const block = await api.call('artifacts.create', { type: 'email_block', name: 'Bundle footer', content: header() });
    const id = block.artifactId;
    const template = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Issue with new footer',
      content: { purpose: 'marketing_email', subject: 'Issue', mjml: frame(`{% block '${id}', title: 'Weekly' %}`) },
    });

    const refused = await rejects(api.call('artifacts.requestPublish', { artifactId: template.artifactId, note: 'issue' }));
    expect(refused.message).toMatch(/not a published e-mail block/);

    const bundle = await api.call('artifacts.requestPublishBundle', {
      artifactIds: [template.artifactId, block.artifactId],
      note: 'New footer and this week’s issue',
    });
    expect(bundle.status).toBe('published');
    expect(bundle.members.map((m) => m.artifactId)).toEqual([block.artifactId, template.artifactId]);
    expect((await api.call('artifacts.get', { artifactId: block.artifactId })).publishedVersion).toBe(1);
    expect((await api.call('artifacts.get', { artifactId: template.artifactId })).publishedVersion).toBe(1);
  });

  it('reports the missing required parameter as a render error', async () => {
    const api = t.api(owner);
    const block = await api.call('artifacts.create', { type: 'email_block', name: 'Required header', content: header() });
    const id = block.artifactId;
    await api.call('artifacts.requestPublish', { artifactId: id, note: 'header' });
    const template = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Missing title',
      content: { purpose: 'marketing_email', subject: 'x', mjml: frame(`{% block '${id}', body: '<p>Hi</p>' %}`) },
    });
    await expect(api.call('templates.preview', { artifactId: template.artifactId })).rejects.toThrow(/needs the parameter "title"/);
  });

  it('refuses a block that uses another block', async () => {
    const api = t.api(owner);
    const e = await rejects(
      api.call('artifacts.create', {
        type: 'email_block',
        name: 'Nested',
        content: {
          category: 'section',
          mjml: "<mj-section><mj-column>{% block 'blk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' %}</mj-column></mj-section>",
          params: [],
        },
      }),
    );
    expect(e.message).toMatch(/cannot use another block/);
  });

  it('lists the templates whose latest or published version uses a block', async () => {
    const api = t.api(owner);
    const block = await api.call('artifacts.create', { type: 'email_block', name: 'Usage header', content: header() });
    const id = block.artifactId;
    await api.call('artifacts.requestPublish', { artifactId: id, note: 'header' });
    const live = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Live issue',
      content: { purpose: 'marketing_email', subject: 'a', mjml: frame(`{% block '${id}', title: 'Live' %}`) },
    });
    await api.call('artifacts.requestPublish', { artifactId: live.artifactId, note: 'live' });
    const draft = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Next issue',
      content: { purpose: 'marketing_email', subject: 'b', mjml: frame(`{% block '${id}', title: 'Next' %}`) },
    });
    const usage = await api.call('blocks.usage', { artifactId: block.artifactId });
    expect(usage.templates.map((x) => x.name).sort()).toEqual(['Live issue', 'Next issue']);
    const liveRow = usage.templates.find((x) => x.artifactId === live.artifactId)!;
    expect(liveRow).toMatchObject({ publishedVersion: 1, usesPublished: true, usesLatest: true });
    const draftRow = usage.templates.find((x) => x.artifactId === draft.artifactId)!;
    expect(draftRow).toMatchObject({ publishedVersion: null, usesPublished: false, usesLatest: true });
  });
});
