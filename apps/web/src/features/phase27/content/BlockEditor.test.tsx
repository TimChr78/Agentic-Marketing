import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockEditor } from '../../blocks/BlockEditor';
import type { BlockContent } from '../../blocks/model';

afterEach(cleanup);

const content: BlockContent = {
  description: 'A shared editorial header',
  category: 'header',
  mjml: '<mj-section><mj-column><mj-text>{{ block.title }}</mj-text></mj-column></mj-section>',
  params: [
    { key: 'title', label: 'Title', type: 'text', required: true, default: 'This week', maxLength: 80 },
    { key: 'link', label: 'Link', type: 'url' },
    { key: 'image', label: 'Image', type: 'image' },
    { key: 'colour', label: 'Colour', type: 'color' },
    { key: 'body', label: 'Body', type: 'html', default: '<p>Your text</p>' },
  ],
};

const renderEditor = (over: Partial<BlockContent> = {}, readOnly = false) => {
  const onChange = vi.fn();
  render(
    <BlockEditor
      artifact={{ version: { content } } as never}
      content={{ ...content, ...over }}
      onChange={onChange}
      readOnly={readOnly}
      errors={{}}
      warnings={[]}
    />,
  );
  return onChange;
};

describe('Block editor (#526)', () => {
  it('keeps category, description and the MJML fragment', () => {
    renderEditor();
    expect(screen.getByLabelText(/^Description/)).toHaveProperty('value', 'A shared editorial header');
    expect(screen.getByLabelText(/^Category/)).toHaveProperty('value', 'header');
    expect(screen.getByLabelText('MJML fragment')).toHaveProperty('value', content.mjml);
  });

  it('keeps every parameter field and every parameter type', () => {
    renderEditor();
    expect(screen.getAllByLabelText(/^Key/)).toHaveLength(5);
    expect(screen.getAllByLabelText(/^Label/)).toHaveLength(5);
    expect(screen.getAllByLabelText(/^Type/)).toHaveLength(5);
    expect(screen.getAllByLabelText(/^Max length/)).toHaveLength(5);
    expect(screen.getAllByLabelText(/^Default/)).toHaveLength(5);
    expect(screen.getAllByRole('checkbox', { name: 'Required' })).toHaveLength(5);
    const type = screen.getAllByLabelText(/^Type/)[0];
    for (const label of ['Text', 'URL', 'Image URL', 'Colour', 'HTML (raw)']) {
      expect(within(type).getByRole('option', { name: label })).toBeTruthy();
    }
    expect(screen.getAllByLabelText(/^Max length/)[0]).toHaveProperty('value', '80');
    expect(screen.getAllByLabelText(/^Default/)[0]).toHaveProperty('value', 'This week');
  });

  it('adds and removes parameters without touching the others', async () => {
    const onChange = renderEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.arrayContaining([expect.objectContaining({ key: '', label: '', type: 'text', required: false })]),
      }),
    );
    cleanup();
    const next = renderEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Remove title' }));
    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.not.arrayContaining([expect.objectContaining({ key: 'title' })]) }),
    );
  });

  it('edits a parameter key and type through onChange', () => {
    const onChange = renderEditor();
    fireEvent.change(screen.getAllByLabelText(/^Key/)[0], { target: { value: 'headline' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.arrayContaining([expect.objectContaining({ key: 'headline' })]) }),
    );
    cleanup();
    const second = renderEditor();
    fireEvent.change(screen.getAllByLabelText(/^Type/)[1], { target: { value: 'image' } });
    expect(second).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.arrayContaining([expect.objectContaining({ type: 'image' })]) }),
    );
  });

  it('is readable without mutation controls when read-only', () => {
    renderEditor({}, true);
    expect(screen.getByLabelText('MJML fragment')).toHaveProperty('readOnly', true);
    expect(screen.queryByRole('button', { name: 'Add parameter' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });
});
