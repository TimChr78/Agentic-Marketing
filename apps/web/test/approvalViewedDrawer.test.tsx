import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #498 review: opening the drawer is not viewing. The exact version counts as viewed only when
// its rendered Review has actually loaded and succeeded, never on mount and never after a failed
// preview.

const h = vi.hoisted(() => ({
  failPreview: false,
  holdPreview: false,
  resolvePreview: null as null | ((value: unknown) => void),
}));

const preview = () => ({
  version: 2,
  subject: 'Reviewed subject',
  preheader: '',
  html: '<html><body><p>Reviewed body</p></body></html>',
  text: 'Reviewed body',
  warnings: [],
});

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string) => {
        if (name === 'approvals.get') return Promise.resolve(detail);
        if (name === 'templates.preview') {
          if (h.failPreview) return Promise.reject(new Error('The renderer could not expand this template.'));
          if (h.holdPreview) return new Promise((resolve) => (h.resolvePreview = resolve));
          return Promise.resolve(preview());
        }
        if (name === 'templates.check')
          return Promise.resolve({
            version: 2,
            findings: [],
            checkedAt: '2026-11-06T10:32:00Z',
            summary: { blocking: 0, warning: 0, info: 0 },
          });
        if (name === 'purposes.list') return Promise.resolve({ source: 'published', purposes: [] });
        if (name === 'system.status')
          return Promise.resolve({
            serverVersion: '0.11.0',
            emailProvider: { configured: true, marketing: true, transactional: true, adapter: 'log' },
            pendingApprovals: 0,
          });
        if (name === 'sendingDomains.list') return Promise.resolve({ checkedAt: '2026-11-06T10:32:00Z', domains: [] });
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_reviewer' } }),
  useWorkspace: () => ({
    can: () => true,
    user: { id: 'usr_reviewer' },
    workspace: { id: 'ws_1', approvalPolicy: 'agent_changes' },
  }),
}));

import { ApprovalDrawer } from '../src/features/approvals/ApprovalDrawer';
import { wasViewed } from '../src/features/approvals/viewed';
import { ToastProvider } from '../src/ui/toast';

const eml = `eml_${'a'.repeat(32)}`;

const detail = {
  id: 'apr_1',
  artifactId: eml,
  artifactName: 'Viewed template',
  artifactType: 'email_template',
  version: 2,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
  note: 'Review this exact version.',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 2,
  artifactPublishedVersion: 1,
  publishedVersion: 1,
  reviewUrl: null,
  bundle: null,
  content: {
    purpose: 'marketing_email',
    subject: 'Reviewed subject',
    preheader: '',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Reviewed body</mj-text></mj-column></mj-section></mj-body></mjml>',
  },
  publishedContent: null,
  diff: { from: 1, to: 2, changes: [] },
  history: [],
};

function renderDrawer() {
  return render(
    <ToastProvider>
      <ApprovalDrawer id={detail.id} queue={[detail.id]} onClose={() => {}} onDecided={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  h.failPreview = false;
  h.holdPreview = false;
  h.resolvePreview = null;
  localStorage.clear();
});

afterEach(cleanup);

describe('a request is viewed only after its rendered Review succeeds (#498 review)', () => {
  it('never marks a request viewed when the preview fails', async () => {
    h.failPreview = true;
    renderDrawer();

    expect(await screen.findByText("Couldn't render this e-mail")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Rendering the e-mail')).toBeNull());
    expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(false);
  });

  it('does not mark viewed while the exact version is still loading', async () => {
    h.holdPreview = true;
    renderDrawer();

    expect(await screen.findByRole('status', { name: 'Rendering the e-mail' })).toBeTruthy();
    expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(false);

    // The status can render before the held preview request starts; resolve only once it has, or
    // a no-op resolve leaves the preview pending and the version never viewed.
    await waitFor(() => expect(h.resolvePreview).toBeTypeOf('function'));
    await act(async () => {
      h.resolvePreview?.(preview());
    });
    expect((await screen.findAllByText('Reviewed subject')).length).toBeGreaterThan(0);
    await waitFor(() => expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(true));
  });

  it('marks the exact version viewed after its rendered Review loads', async () => {
    renderDrawer();
    expect((await screen.findAllByText('Reviewed subject')).length).toBeGreaterThan(0);
    await waitFor(() => expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(true));
    // A newer version of the same request is a new review.
    expect(wasViewed('usr_reviewer', detail.id, detail.version + 1)).toBe(false);
  });
});
