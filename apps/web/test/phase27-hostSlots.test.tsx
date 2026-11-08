import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ArtifactDetailConfig, ArtifactDetailPage, type EditorProps } from '../src/features/artifacts/ArtifactDetailPage';
import { ArtifactListPage, type ArtifactListTemplate } from '../src/features/artifacts/ArtifactListPage';
import { ToastProvider } from '../src/ui/toast';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as {
    id: string;
    type: string;
    name: string;
    latestVersion: number;
    latestState: 'draft' | 'published';
    publishedVersion: number | null;
    updatedAt: string;
  }[],
  detail: undefined as unknown,
}));

const tpl = `eml_${'a'.repeat(32)}`;
const other = `eml_${'b'.repeat(32)}`;

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        if (name === 'artifacts.list') return { artifacts: h.rows, total: h.rows.length, nextCursor: null };
        if (name === 'approvals.list') return { approvals: [], total: 0, nextCursor: null };
        if (name === 'artifacts.get') return h.detail;
        throw new Error(`unexpected ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, workspace: { id: 'ws-1' } }),
  useWorkspace: () => ({
    can: () => true,
    workspace: { id: 'ws-1', approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  }),
}));

function row(id: string, name: string) {
  return {
    id,
    type: 'email_template',
    name,
    latestVersion: 2,
    latestState: 'published' as const,
    publishedVersion: 2,
    updatedAt: '2026-11-02T09:00:00.000Z',
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.rows = [row(tpl, 'Weekly Signal #43'), row(other, 'Confirm your subscription')];
  h.detail = {
    id: tpl,
    type: 'email_template',
    name: 'Weekly Signal #43',
    latestVersion: 2,
    publishedVersion: 2,
    version: {
      number: 2,
      state: 'published',
      content: { subject: 'Signal #43' },
      contentHash: 'hash',
      author: { type: 'user', id: 'u1' },
      createdAt: '2026-11-02T09:00:00.000Z',
    },
  };
});

afterEach(cleanup);

describe('artifact list host slots (#524)', () => {
  it('keeps the Phase 24–26 default list exactly: table, filters, totals and the create dialog', async () => {
    render(
      <ToastProvider>
        <ArtifactListPage
          type="email_template"
          title="E-mail templates"
          description="E-mails in MJML."
          emptyTitle="No e-mail templates yet"
          emptyText="Create one."
          create={{ label: 'New template', content: (name) => ({ subject: name }) }}
        />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'E-mail templates' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByLabelText('Search e-mail templates')).toBeTruthy();
    expect(screen.getByLabelText('Publication state')).toBeTruthy();
    expect(screen.getByText('2 total')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Templates on a phone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    expect(screen.getByLabelText(/Name/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeTruthy();
  });

  it('lets a family opt into the v2 list template and keeps every field and action', async () => {
    const template: ArtifactListTemplate = {
      mobileRow: (a) => (
        <li key={a.id} aria-label={`${a.name} summary`}>
          <span>{a.name}</span>
          <span>v{a.latestVersion}</span>
        </li>
      ),
      filters: <select aria-label="Kind" />,
      pagination: <button type="button">Next page</button>,
    };
    render(
      <ToastProvider>
        <ArtifactListPage
          type="email_template"
          title="E-mail templates"
          description="E-mails in MJML."
          emptyTitle="No e-mail templates yet"
          emptyText="Create one."
          create={{ label: 'New template', content: (name) => ({ subject: name }) }}
          template={template}
        />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'E-mail templates' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'E-mail templates on a phone' })).toBeTruthy();
    expect(screen.getByLabelText('Kind')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New template' })).toBeTruthy();
    expect(screen.getByText('2 total')).toBeTruthy();
  });

  it('keeps the family filters and an inline notice for a filtered-out empty list', async () => {
    const template: ArtifactListTemplate = {
      mobileRow: (a) => <li key={a.id}>{a.name}</li>,
      filters: <select aria-label="Kind" />,
    };
    render(
      <ToastProvider>
        <ArtifactListPage
          type="email_template"
          title="E-mail templates"
          description="E-mails in MJML."
          emptyTitle="No e-mail templates yet"
          emptyText="Create one."
          template={template}
        />
      </ToastProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Search e-mail templates'), { target: { value: 'nothing like it' } });
    await waitFor(() => expect(screen.getByText('Nothing matches')).toBeTruthy());
    expect(screen.getByLabelText('Kind')).toBeTruthy();
    expect(screen.getByText('Nothing matches')).toBeTruthy();
  });
});

describe('artifact detail host slots (#524)', () => {
  const editor = (p: EditorProps) => <p>{String((p.content as { subject: string }).subject)}</p>;

  it('keeps the Phase 24–26 default detail: page header and the existing tabs, no context panel', async () => {
    render(
      <ToastProvider>
        <ArtifactDetailPage id={tpl} crumbs={[{ label: 'Templates', to: '/content/templates' }]} editor={editor} />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly Signal #43' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Content' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Versions/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Context' })).toBeNull();
    expect(screen.queryByText('All checks pass')).toBeNull();
  });

  it('delegates to the detail template when a family opts in, without losing any tab', async () => {
    const detail: ArtifactDetailConfig = {
      kind: 'E-mail template',
      context: () => <p>All checks pass</p>,
      metadata: () => <span>Published v2</span>,
    };
    render(
      <ToastProvider>
        <ArtifactDetailPage id={tpl} crumbs={[{ label: 'Templates', to: '/content/templates' }]} editor={editor} detail={detail} />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly Signal #43' })).toBeTruthy();
    expect(screen.getByText('All checks pass')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Content' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Versions/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByText('Published v2')).toBeTruthy();
  });

  it('does not lose the accidental-action slots when the template is used', async () => {
    const detail: ArtifactDetailConfig = {
      actions: () => ({
        primary: <button type="button">Publish</button>,
        secondary: <button type="button">Copy identifier</button>,
      }),
    };
    render(
      <ToastProvider>
        <ArtifactDetailPage id={tpl} crumbs={[]} editor={editor} detail={detail} />
      </ToastProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy identifier' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
  });
});
