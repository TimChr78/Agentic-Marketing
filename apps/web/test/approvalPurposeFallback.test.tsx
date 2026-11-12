import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDrawer } from '../src/features/approvals/ApprovalDrawer';
import { invalidateArtifact } from '../src/features/artifactCache';
import { ToastProvider } from '../src/ui/toast';

// #600: the consequence panel must not print an unresolved saved purpose's technical key as its
// label. It uses the 0.14.0 fallback and keeps the key behind the copy control.

const eml = `eml_${'a'.repeat(32)}`;

const h = vi.hoisted(() => ({
  detail: null as unknown,
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string) => {
        if (name === 'approvals.get') return Promise.resolve(h.detail);
        if (name === 'artifacts.get')
          return Promise.resolve({
            id: eml,
            type: 'email_template',
            name: 'Weekly Signal',
            latestVersion: 4,
            publishedVersion: 4,
            version: { number: 4, state: 'published', content: { purpose: 'legacy_purpose' } },
            layout: null,
            references: [],
          });
        if (name === 'templates.preview')
          return Promise.resolve({
            version: 4,
            subject: 'Subject',
            preheader: '',
            html: '<html><body><p>Body</p></body></html>',
            text: 'Body',
            warnings: [],
          });
        if (name === 'templates.check')
          return Promise.resolve({
            version: 4,
            findings: [],
            checkedAt: '2026-11-06T10:32:00Z',
            summary: { blocking: 0, warning: 0, info: 0 },
          });
        if (name === 'purposes.list') return Promise.resolve({ source: 'published', purposes: [] });
        if (name === 'system.status')
          return Promise.resolve({
            serverVersion: '0.14.6',
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

const requester = { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null };

const detail = {
  id: 'apr_template',
  artifactId: eml,
  artifactName: 'Weekly Signal',
  artifactType: 'email_template',
  version: 4,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester,
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 4,
  artifactPublishedVersion: 3,
  publishedVersion: 3,
  reviewUrl: null,
  bundle: null,
  publishedContent: null,
  content: { purpose: 'legacy_purpose', subject: 'Subject', preheader: '', mjml: '<mjml><mj-body /></mjml>' },
  diff: { from: 3, to: 4, changes: [] },
  history: [],
};

beforeEach(() => {
  h.detail = detail;
  localStorage.clear();
  invalidateArtifact(eml);
});

afterEach(cleanup);

describe('approval purpose fallback (#600)', () => {
  it('names an unresolved saved purpose “Unavailable purpose” and keeps its key behind the copy control', async () => {
    render(
      <ToastProvider>
        <ApprovalDrawer id={detail.id} queue={[detail.id]} onClose={() => {}} onDecided={() => {}} />
      </ToastProvider>,
    );

    const fallback = await screen.findAllByText('Unavailable purpose');
    expect(fallback.length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Copy purpose key legacy_purpose' }).length).toBeGreaterThan(0);
  });
});
