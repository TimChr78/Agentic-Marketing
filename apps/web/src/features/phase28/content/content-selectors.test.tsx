import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockPicker } from '../../blocks/BlockPicker';
import { type TemplateContent, TemplateEditor } from '../../templates/TemplateEditor';

// Phase 28 (#559) content polish: the purpose and topic selectors name purposes without their
// technical keys, an unresolved reference says so and keeps the copy affordance, and the visual
// editor reserves its existing height while its chunk loads.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  purposes: [
    { key: 'marketing_email', name: 'Marketing e-mail', topics: [{ key: 'news', name: 'News', default: 'subscribed' }] },
    { key: 'transactional_email', name: 'Transactional e-mail', topics: [] },
  ],
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'purposes.list') return { purposes: h.purposes };
        if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => true, switchWorkspace: async () => {} }),
}));

// The lazy visual editor never resolves, so its Suspense fallback is what the test sees.
vi.mock('../../templates/VisualMjml', () => ({
  default: () => {
    throw new Promise<void>(() => {});
  },
}));
vi.mock('../../templates/EditorPreview', () => ({ EditorPreview: () => <div>Recipient preview</div> }));

const content: TemplateContent = {
  subject: 'A quieter way to keep in touch',
  purpose: 'marketing_email',
  topic: 'news',
  mjml: '<mjml><mj-body><mj-section><mj-column /></mj-section></mj-body></mjml>',
};

const renderEditor = (over: Partial<TemplateContent> = {}) =>
  render(
    <TemplateEditor
      artifact={{ id: `tpl_${'a'.repeat(32)}`, version: { number: 3, content } } as never}
      content={{ ...content, ...over }}
      onChange={vi.fn()}
      readOnly={false}
      errors={{}}
      warnings={[]}
    />,
  );

beforeEach(() => {
  h.calls = [];
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });
});
afterEach(cleanup);

const optionTexts = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.textContent?.trim());

describe('content selectors name purposes (#559 C1)', () => {
  it('shows purpose names alone and keeps the selected value', async () => {
    renderEditor();
    const purpose = screen.getByLabelText(/^Purpose/) as HTMLSelectElement;
    await waitFor(() => expect(optionTexts(purpose)).toEqual(['Marketing e-mail', 'Transactional e-mail']));
    expect(purpose.value).toBe('marketing_email');
    expect(optionTexts(purpose).join(' ')).not.toContain('marketing_email');
  });

  it('names an unavailable saved purpose and keeps its key in the copy affordance only', async () => {
    renderEditor({ purpose: 'legacy_news', topic: undefined });
    const purpose = screen.getByLabelText(/^Purpose/) as HTMLSelectElement;
    await waitFor(() => expect(optionTexts(purpose)).toContain('Unavailable purpose'));
    expect(purpose.value).toBe('legacy_news');
    expect(optionTexts(purpose).join(' ')).not.toContain('legacy_news');
    expect(screen.getByText('The saved purpose is unavailable. Choose a purpose to replace it.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Purpose ID: legacy_n/ })).toBeTruthy();
  });

  it('shows topic names alone', async () => {
    renderEditor();
    const topic = await waitFor(() => screen.getByLabelText(/^Topic/) as HTMLSelectElement);
    await waitFor(() => expect(optionTexts(topic)).toContain('News'));
    expect(optionTexts(topic).join(' ')).not.toContain('News (news)');
    expect(topic.value).toBe('news');
  });
});

describe('the visual editor reserves its height (#559)', () => {
  it('shows the labelled editor skeleton in the existing frame while the chunk loads', () => {
    renderEditor();
    const region = screen.getByRole('status', { name: 'Loading the visual editor' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.querySelector('[data-skeleton-shape="editor"]')).toBeTruthy();
    expect(region.querySelector('[data-skeleton-shape="editor"]')?.className).toContain('h-[420px]');
    expect(region.querySelector('[data-skeleton-shape="editor"]')?.className).toContain('md:h-[560px]');
  });
});

describe('empty content lists name their action (#559)', () => {
  it('names the create action in an empty block picker', async () => {
    render(<BlockPicker onClose={vi.fn()} onPick={vi.fn()} />);
    const empty = await screen.findByText(/No reusable blocks yet/);
    expect(empty.textContent).toBe('No reusable blocks yet. Create one in Design → Blocks.');
  });
});

describe('the editor chrome copy stays app copy (#559 C2)', () => {
  const source = (file: string) => readFileSync(join(process.cwd(), 'apps/web/src/features/templates', file), 'utf8');

  it('replaces the third-party inspector empty state without a tool name', () => {
    const code = source('VisualMjml.tsx');
    expect(code).toContain("styleManager: { empty: 'Select an element to edit its styles' }");
    expect(code).toContain("traitManager: { empty: 'Select an element to edit its settings' }");
    expect(code).not.toContain('before using Style Manager');
  });

  it('scopes every editor.css selector to the editor container', () => {
    const css = source('editor.css');
    const selectors = css
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('{') && !line.startsWith('@') && !line.startsWith('/*'));
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) expect(selector.startsWith('.am-gjs')).toBe(true);
  });
});
