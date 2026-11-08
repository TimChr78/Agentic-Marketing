import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HostedPagesPage from '../../../pages/design/HostedPagesPage';

const h = vi.hoisted(() => ({
  archive: { enabled: true, indexUrl: 'https://links.example/n/journal/' } as { enabled: boolean; indexUrl?: string },
  forms: [] as unknown[],
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'artifacts.list') return { artifacts: h.forms, total: h.forms.length, nextCursor: null };
        if (name === 'archive.issues') return { settings: h.archive, issues: [] };
        if (name === 'hostedPages.preview') return { html: '<p>Hosted page</p>' };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../features/brand/HostedPreview', () => ({
  HostedPreview: ({ formId }: { formId?: string }) => <div>Hosted preview {formId ?? 'workspace brand'}</div>,
}));

beforeEach(() => {
  h.archive = { enabled: true, indexUrl: 'https://links.example/n/journal/' };
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
});
afterEach(cleanup);

describe('Subscriber pages (#526)', () => {
  it('keeps the preview, form selector, archive, Edit brand and path help', async () => {
    render(<HostedPagesPage />);
    expect(await screen.findByText('Hosted preview workspace brand')).toBeTruthy();
    expect(screen.getByLabelText(/^Form/)).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Newsletter signup' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit brand' })).toBeTruthy();
    expect(screen.getByText(/published brand, not unsaved edits/)).toBeTruthy();
    expect(screen.getByText(/RSS feed and a sitemap/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the live archive' })).toBeTruthy();
    expect(screen.getByText('/f/confirm/…')).toBeTruthy();
    expect(screen.getByText(/Opening a link never confirms or unsubscribes/)).toBeTruthy();
  });

  it('explains the neutral look when no archive is configured', async () => {
    h.archive = { enabled: false };
    render(<HostedPagesPage />);
    expect(await screen.findByText(/No public archive yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Set up the archive' })).toBeTruthy();
  });
});
