import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TemplateContent, TemplateEditor } from '../../templates/TemplateEditor';

const h = vi.hoisted(() => ({ calls: [] as { name: string; input: Record<string, unknown> }[] }));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'purposes.list')
          return {
            purposes: [
              {
                key: 'marketing_email',
                name: 'Marketing e-mail',
                topics: [{ key: 'news', name: 'News', default: 'subscribed' }],
              },
            ],
          };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../templates/VisualMjml', () => ({ default: () => <div>Visual editor</div> }));
vi.mock('../../templates/EditorPreview', () => ({ EditorPreview: () => <div>Recipient preview</div> }));

const content: TemplateContent = {
  subject: 'A quieter way to keep in touch',
  preheader: 'This week from Northstar',
  purpose: 'marketing_email',
  topic: 'news',
  mjml: '<mjml><mj-body><mj-section><mj-column /></mj-section></mj-body></mjml>',
  text: 'A plain-text version.',
  sampleData: { profile: { firstName: 'Ada' } },
  utm: { source: 'newsletter', medium: 'email', campaign: 'weekly-journal' },
};

const renderEditor = (over: Partial<TemplateContent> = {}, readOnly = false) => {
  const onChange = vi.fn();
  render(
    <TemplateEditor
      artifact={{ id: `eml_${'a'.repeat(32)}`, version: { number: 3, content } } as never}
      content={{ ...content, ...over }}
      onChange={onChange}
      readOnly={readOnly}
      errors={{}}
      warnings={[]}
    />,
  );
  return onChange;
};

beforeEach(() => {
  h.calls = [];
});
afterEach(cleanup);

describe('Template editor (#526)', () => {
  it('keeps subject, preheader, purpose and topic', async () => {
    renderEditor();
    expect(screen.getByLabelText(/^Subject/)).toHaveProperty('value', content.subject);
    expect(screen.getByLabelText(/^Preheader/)).toHaveProperty('value', content.preheader);
    expect(screen.getByLabelText(/^Purpose/)).toHaveProperty('value', 'marketing_email');
    await waitFor(() => expect(screen.getByLabelText(/^Topic/)).toHaveProperty('value', 'news'));
    expect(h.calls.filter((c) => c.name === 'purposes.list')).toHaveLength(1);
  });

  it('keeps visual and code modes, insert, undo, redo, outlines and the preview toggle', async () => {
    renderEditor();
    expect(screen.getByRole('radio', { name: 'Visual' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'MJML and Liquid' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Insert' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outlines' })).toBeTruthy();
    const preview = screen.getByRole('button', { name: 'Preview' });
    expect(preview.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Recipient preview')).toBeTruthy();
    await userEvent.click(preview);
    expect(preview.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Recipient preview')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'MJML and Liquid' }));
    expect(screen.getByLabelText('MJML with Liquid')).toHaveProperty('value', content.mjml);
  });

  it('keeps the plain-text version, sample data and UTM fields under Advanced', async () => {
    renderEditor();
    await userEvent.click(screen.getByText('Advanced: text version, sample data, UTM'));
    expect(screen.getByLabelText(/^Plain-text version/)).toHaveProperty('value', content.text);
    expect(screen.getByText('Sample data for previews')).toBeTruthy();
    expect(screen.getByLabelText(/^UTM source/)).toHaveProperty('value', 'newsletter');
    expect(screen.getByLabelText(/^UTM medium/)).toHaveProperty('value', 'email');
    expect(screen.getByLabelText(/^UTM campaign/)).toHaveProperty('value', 'weekly-journal');
  });

  it('edits the subject and keeps the read-only preview reachable', () => {
    const onChange = renderEditor();
    fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: 'New subject' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subject: 'New subject' }));
    cleanup();
    renderEditor({}, true);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
  });
});
