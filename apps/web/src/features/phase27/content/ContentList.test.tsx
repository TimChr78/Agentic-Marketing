import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../ui';
import { ContentList } from './ContentList';

type Call = { name: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: [] as unknown[],
  total: 0,
  error: null as Error | null,
  can: true,
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.list') {
          if (h.error) throw h.error;
          return { artifacts: h.rows, total: h.total, nextCursor: null };
        }
        if (name === 'artifacts.create') return { artifactId: `eml_${'a'.repeat(32)}` };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => h.can }),
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: `eml_${'a'.repeat(32)}`,
  type: 'email_template',
  name: 'Weekly journal',
  latestVersion: 3,
  latestState: 'draft',
  publishedVersion: 2,
  updatedAt: '2026-11-02T09:00:00.000Z',
  ...over,
});

const spec = {
  label: 'New template',
  content: (name: string) => ({ subject: name, mjml: '<mjml />' }),
};

const gallery = (over: Partial<Parameters<typeof ContentList>[0]> = {}) => (
  <ToastProvider>
    <ContentList
      type="email_template"
      title="E-mail templates"
      noun="templates"
      layout="gallery"
      description="E-mails in MJML."
      emptyTitle="No e-mail templates yet"
      emptyText="Create one."
      create={spec}
      {...over}
    />
  </ToastProvider>
);

beforeEach(() => {
  h.calls = [];
  h.error = null;
  h.can = true;
  h.total = 2;
  h.rows = [row(), row({ id: `eml_${'b'.repeat(32)}`, name: 'Welcome', latestState: 'in_review', publishedVersion: null })];
});

afterEach(() => cleanup());

describe('Content list (#526)', () => {
  it('shows one primary action, name search and publication filter over a thumbnail gallery', async () => {
    render(gallery());
    expect(screen.getByRole('heading', { level: 1, name: 'E-mail templates' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New template' })).toBeTruthy();
    expect(screen.getByLabelText('Search templates')).toBeTruthy();
    expect(screen.getByLabelText('Publication state')).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'E-mail templates gallery' })).toBeTruthy();
    expect(screen.getAllByText('Weekly journal').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Published v2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 templates').length).toBeGreaterThan(0);
    // One complete list read; no detail row read.
    expect(h.calls.filter((c) => c.name === 'artifacts.list')).toHaveLength(1);
    expect(h.calls.some((c) => c.name === 'artifacts.get')).toBe(false);
  });

  it('filters on the loaded index without another read and offers Clear filters', async () => {
    render(gallery());
    await screen.findByRole('list', { name: 'E-mail templates gallery' });
    await userEvent.type(screen.getByLabelText('Search templates'), 'welcome');
    expect(screen.queryByText('Weekly journal')).toBeNull();
    expect(screen.getAllByText('Welcome').length).toBeGreaterThan(0);
    await userEvent.clear(screen.getByLabelText('Search templates'));
    await userEvent.type(screen.getByLabelText('Search templates'), 'nothing');
    expect(screen.getByText('Nothing matches')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getAllByText('Weekly journal').length).toBeGreaterThan(0);
    expect(h.calls.filter((c) => c.name === 'artifacts.list')).toHaveLength(1);
  });

  it('creates a draft from the existing dialog and keeps the create intent', async () => {
    render(gallery());
    await userEvent.click(screen.getByRole('button', { name: 'New template' }));
    const dialog = screen.getByRole('dialog', { name: 'New template' });
    await userEvent.type(within(dialog).getByLabelText(/Name/), 'Launch note');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(h.calls.find((c) => c.name === 'artifacts.create')?.input).toMatchObject({
        type: 'email_template',
        name: 'Launch note',
        content: { subject: 'Launch note', mjml: '<mjml />' },
      }),
    );
  });

  it('renders Blocks as a comparison table, not a gallery', async () => {
    h.rows = [row({ type: 'email_block', name: 'Editorial header' })];
    h.total = 1;
    render(gallery({ type: 'email_block', title: 'Blocks', noun: 'blocks', layout: 'table', create: { ...spec, label: 'New block' } }));
    expect(await screen.findByRole('table', { name: 'Blocks' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Publication' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Operational state' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Blocks gallery' })).toBeNull();
  });

  it('explains a restricted read and issues no denied request', async () => {
    h.can = false;
    render(gallery());
    expect(screen.getByText('Restricted access')).toBeTruthy();
    expect(screen.getByText(/Ask a workspace admin for artifacts:read/)).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'artifacts.list')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'New template' })).toBeNull();
  });

  it('keeps the empty create flow and the failed read with Retry', async () => {
    h.rows = [];
    h.total = 0;
    const { unmount } = render(gallery());
    expect(await screen.findByText('No e-mail templates yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New template' }).length).toBeGreaterThan(0);
    unmount();

    h.error = new Error('Server unavailable');
    render(gallery());
    expect(await screen.findByText('Couldn’t load templates')).toBeTruthy();
    expect(screen.getByText('Server unavailable')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.calls.filter((c) => c.name === 'artifacts.list')).toHaveLength(3);
  });
});
