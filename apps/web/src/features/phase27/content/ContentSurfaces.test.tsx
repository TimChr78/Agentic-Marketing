import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlockPage from '../../../pages/design/BlockPage';
import BrandPage from '../../../pages/design/BrandPage';
import TemplatePage from '../../../pages/design/TemplatePage';
import TemplatesPage from '../../../pages/design/TemplatesPage';
import { ToastProvider } from '../../../ui';

type Call = { name: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  brand: null as unknown,
  forms: [] as unknown[],
  archive: { enabled: false } as { enabled: boolean; indexUrl?: string },
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.list') {
          if (input.type === 'brand') return { artifacts: h.brand ? [h.brand] : [], total: h.brand ? 1 : 0, nextCursor: null };
          if (input.type === 'form') return { artifacts: h.forms, total: h.forms.length, nextCursor: null };
          return { artifacts: [], total: 0, nextCursor: null };
        }
        if (name === 'templates.sendTest') return { to: 'you@example.com' };
        if (name === 'archive.issues') return { settings: h.archive, issues: [] };
        if (name === 'hostedPages.preview') return { html: '<p>Hosted page</p>' };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => true }),
  useWorkspace: () => ({ can: () => true, workspace: { name: 'Northstar', approvalPolicy: 'none' } }),
}));

// The page composition only; the editors, preview and recipe gallery have their own tests.
vi.mock('../../../features/artifacts/ArtifactDetailPage', () => ({
  ArtifactDetailPage: (props: {
    id: string;
    preview?: boolean;
    extraActions?: (a: { id: string; version: { number: number } }) => ReactNode;
    extraTabs?: { key: string; label: string }[];
    detail?: { context?: (a: unknown, view: unknown) => ReactNode };
  }) => (
    <div>
      <p>detail {props.id}</p>
      <p>preview {String(!!props.preview)}</p>
      {props.extraActions?.({ id: props.id, version: { number: 3 } })}
      {props.extraTabs?.map((t) => (
        <p key={t.key}>{t.label}</p>
      ))}
      {props.detail?.context?.({ version: { content: {} } }, { dirty: false, draft: undefined, hasPending: false })}
    </div>
  ),
}));

vi.mock('../../../pages/build/RecipesPage', () => ({ default: () => <div>Starters gallery stub</div> }));
vi.mock('../../../pages/design/HostedPagesPage', () => ({ default: () => <div>Subscriber pages stub</div> }));
vi.mock('../../../features/brand/HostedPreview', () => ({
  HostedPreview: ({ formId }: { formId?: string }) => <div>Hosted preview {formId ?? 'workspace brand'}</div>,
}));

const brand = {
  id: `brd_${'a'.repeat(32)}`,
  name: 'Brand',
  latestVersion: 3,
  latestState: 'draft',
  publishedVersion: 2,
  updatedAt: '2026-11-02T09:00:00.000Z',
};

beforeEach(() => {
  h.calls = [];
  h.brand = brand;
  h.forms = [
    {
      id: `frm_${'b'.repeat(32)}`,
      type: 'form',
      name: 'Newsletter signup',
      latestVersion: 1,
      latestState: 'published',
      publishedVersion: 1,
      updatedAt: '2026-11-02T09:00:00.000Z',
    },
  ];
  h.archive = { enabled: true, indexUrl: 'https://links.example/n/journal/' };
  window.history.replaceState(null, '', '/content/templates');
});
afterEach(cleanup);

describe('Content surfaces (#526)', () => {
  it('keeps Send me a test on the template detail for the saved version', async () => {
    render(
      <ToastProvider>
        <TemplatePage params={{ id: `eml_${'c'.repeat(32)}` }} />
      </ToastProvider>,
    );
    expect(screen.getByText('detail eml_cccccccccccccccccccccccccccccccc')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Send me a test' }));
    await waitFor(() =>
      expect(h.calls.find((c) => c.name === 'templates.sendTest')?.input).toEqual({
        artifactId: `eml_${'c'.repeat(32)}`,
        version: 3,
      }),
    );
  });

  it('keeps the block Preview and Used by sections', () => {
    render(<BlockPage params={{ id: `blk_${'d'.repeat(32)}` }} />);
    expect(screen.getByText('preview true')).toBeTruthy();
    expect(screen.getByText('Used by')).toBeTruthy();
  });

  it('keeps Brand and Subscriber pages as outer tabs', async () => {
    window.history.replaceState(null, '', '/content/brand?tab=subscriber-pages');
    const { unmount } = render(<BrandPage />);
    expect(screen.getByText('Subscriber pages stub')).toBeTruthy();
    unmount();
    window.history.replaceState(null, '', '/content/brand');
    render(<BrandPage />);
    expect(await screen.findByText('detail brd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeTruthy();
  });

  it('wires the Starters tab to the existing recipe gallery', async () => {
    window.history.replaceState(null, '', '/content/templates?tab=starters');
    render(<TemplatesPage />);
    expect(screen.getByRole('tab', { name: 'Starters' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Starters' })).toBeTruthy();
    expect(screen.getByText('Starters gallery stub')).toBeTruthy();
  });
});
