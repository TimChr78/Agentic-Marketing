import { describe, expect, it } from 'vitest';
import { blockIdsIn, parseBlockTagArgs, wrapMjmlFragment } from '../src/blockTags';
import { type BlockDefinition, renderTemplate } from '../src/render';

const id = `blk_${'a'.repeat(32)}`;
const other = `blk_${'b'.repeat(32)}`;

const header: BlockDefinition = {
  id,
  mjml: `<mj-section><mj-column>
    <mj-text>{{ block.title }}</mj-text>
    <mj-text>{{ block.body }}</mj-text>
    <mj-image src="{{ block.image }}" alt="{{ block.title }}" />
  </mj-column></mj-section>`,
  params: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'body', label: 'Body', type: 'html', required: false, default: '<p>Default</p>' },
    { key: 'image', label: 'Image', type: 'image', required: true },
  ],
};

const template = {
  purpose: 'marketing_email',
  subject: 'Blocks',
  mjml: `<mjml><mj-body>
    {% block '${id}', title: profile.firstName, body: '<strong>Hi there</strong>', image: 'https://example.com/logo.png' %}
    <mj-section><mj-column><mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text></mj-column></mj-section>
  </mj-body></mjml>`,
};

describe('block tag', () => {
  it('finds block ids, including whitespace-controlled tags', () => {
    expect(blockIdsIn(`{%- block '${id}', title: 'x' -%}{% block "${other}" %}`)).toEqual([id, other]);
    expect(blockIdsIn(`{% block '${id}' %} {% block '${id}' %}`)).toEqual([id]);
    expect(parseBlockTagArgs(` '${id}', title: 'x'`)).toEqual({ id, params: "title: 'x'" });
    expect(parseBlockTagArgs(`'${id}'`)).toEqual({ id, params: null });
    expect(() => parseBlockTagArgs('nope')).toThrow(/quoted block id/);
    expect(wrapMjmlFragment('<mj-section></mj-section>')).toBe('<mjml><mj-body><mj-section></mj-section></mj-body></mjml>');
    expect(wrapMjmlFragment('<mj-text>x</mj-text>')).toContain('<mj-section><mj-column><mj-text>x</mj-text></mj-column></mj-section>');
  });

  it('escapes text parameters but inserts html parameters raw', async () => {
    const r = await renderTemplate(template, { profile: { firstName: '<script>alert(1)</script>' } }, { blocks: () => header });
    expect(r.html).not.toContain('<script>alert(1)');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).toContain('<strong>Hi there</strong>');
    expect(r.html).toContain('https://example.com/logo.png');
    // The nested unsubscribe section still renders after the block is inlined.
    expect(r.html).toContain('Unsubscribe');
  });

  it('falls back to a default for an omitted optional parameter', async () => {
    const t = { ...template, mjml: template.mjml.replace(", body: '<strong>Hi there</strong>'", '') };
    const r = await renderTemplate(t, { profile: { firstName: 'Ada' } }, { blocks: () => header });
    expect(r.html).toContain('Default');
  });

  it('refuses a missing required parameter, an unknown one and a bad URL', async () => {
    const missing = { ...template, mjml: template.mjml.replace('title: profile.firstName, ', '') };
    await expect(renderTemplate(missing, {}, { blocks: () => header })).rejects.toThrow(/needs the parameter "title"/);
    const vars = { profile: { firstName: 'Ada' } };
    const unknown = { ...template, mjml: template.mjml.replace("body: '<strong>Hi there</strong>'", "subtitle: 'x'") };
    await expect(renderTemplate(unknown, vars, { blocks: () => header })).rejects.toThrow(/has no parameter "subtitle"/);
    const badUrl = { ...template, mjml: template.mjml.replace('https://example.com/logo.png', 'javascript:alert(1)') };
    await expect(renderTemplate(badUrl, vars, { blocks: () => header })).rejects.toThrow(/http\(s\) or asset URL/);
  });

  it('refuses an unpublished block and a nested block', async () => {
    await expect(renderTemplate(template, {}, { blocks: () => null })).rejects.toThrow(/not published/);
    await expect(renderTemplate(template, {})).rejects.toThrow(/blocks are not available/);
    const nested = { id, mjml: `<mj-section><mj-column>{% block '${other}' %}</mj-column></mj-section>`, params: [] };
    const t = { ...template, mjml: template.mjml.replace(/{% block[^%]*%}/, `{% block '${id}' %}`) };
    await expect(renderTemplate(t, {}, { blocks: () => nested })).rejects.toThrow(/cannot use other blocks/);
  });
});
