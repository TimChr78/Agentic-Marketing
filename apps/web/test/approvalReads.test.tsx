import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #498 review: the consequence summary and the renderer below it read the same exact preview.
// Assert request counts across the full drawer render, not only the pure read plan.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  detail: null as unknown,
  template: null as unknown,
  segment: null as unknown,
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'approvals.get') return Promise.resolve(h.detail);
        if (name === 'artifacts.get') {
          if (input.artifactId === (h.template as { id: string }).id) return Promise.resolve(h.template);
          if (input.artifactId === (h.segment as { id: string }).id) return Promise.resolve(h.segment);
          throw new Error(`unexpected artifact ${String(input.artifactId)}`);
        }
        if (name === 'templates.preview')
          return Promise.resolve({
            version: Number(input.version ?? 2),
            subject: 'Preview subject',
            preheader: '',
            html: '<html><body><p>Preview body</p></body></html>',
            text: 'Preview body',
            warnings: [],
          });
        if (name === 'templates.check')
          return Promise.resolve({
            version: Number(input.version ?? 2),
            findings: [],
            checkedAt: '2026-11-06T10:32:00Z',
            summary: { blocking: 0, warning: 0, info: 0 },
          });
        if (name === 'broadcasts.preview')
          return Promise.resolve({
            audience: 12480,
            checked: 2000,
            wouldSend: 1842,
            wouldSkip: { no_consent: 20 },
            sendAt: null,
            sendWindow: null,
            subjectTest: null,
          });
        if (name === 'segments.preview') return Promise.resolve({ count: 1842, sample: [], tookMs: 4 });
        if (name === 'purposes.list')
          return Promise.resolve({
            source: 'published',
            purposes: [
              {
                key: 'marketing_email',
                name: 'Marketing e-mail',
                description: '',
                basis: 'consent',
                channels: ['email'],
                requiresDoubleOptIn: false,
                topics: [],
              },
            ],
          });
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
import { invalidateArtifact } from '../src/features/artifactCache';
import { ToastProvider } from '../src/ui/toast';

const eml = `eml_${'a'.repeat(32)}`;
const seg = `seg_${'b'.repeat(32)}`;
const bct = `bct_${'c'.repeat(32)}`;

const requester = { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null };

const base = {
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester,
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 2,
  artifactPublishedVersion: null,
  publishedVersion: null,
  reviewUrl: null,
  bundle: null,
  publishedContent: null,
  diff: { from: null, to: 2, changes: [] },
  history: [],
};

const templateDetail = {
  ...base,
  id: 'apr_template',
  artifactId: eml,
  artifactName: 'Read once template',
  artifactType: 'email_template',
  version: 2,
  content: {
    purpose: 'marketing_email',
    subject: 'Preview subject',
    preheader: '',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Body</mj-text></mj-column></mj-section></mj-body></mjml>',
  },
};

const broadcastDetail = {
  ...base,
  id: 'apr_broadcast',
  artifactId: bct,
  artifactName: 'Read once broadcast',
  artifactType: 'broadcast',
  version: 3,
  content: { template: eml, segment: seg },
};

const segmentDetail = {
  ...base,
  id: 'apr_segment',
  artifactId: seg,
  artifactName: 'Read once segment',
  artifactType: 'segment',
  version: 2,
  content: { description: 'Engaged', condition: { consent: 'marketing_email' } },
};

const templateArtifact = {
  id: eml,
  type: 'email_template',
  name: 'Read once template',
  latestVersion: 5,
  publishedVersion: 5,
  version: { number: 5, state: 'published', content: { purpose: 'marketing_email' } },
  layout: null,
  references: [],
};

const segmentArtifact = {
  id: seg,
  type: 'segment',
  name: 'Engaged readers',
  latestVersion: 2,
  publishedVersion: 2,
  version: { number: 2, state: 'published', content: {} },
  layout: null,
  references: [],
};

function renderDrawer(detail: unknown) {
  h.detail = detail;
  const id = (detail as { id: string }).id;
  return render(
    <ToastProvider>
      <ApprovalDrawer id={id} queue={[id]} onClose={() => {}} onDecided={() => {}} />
    </ToastProvider>,
  );
}

const count = (name: string) => h.calls.filter((c) => c.name === name).length;

beforeEach(() => {
  h.calls.length = 0;
  h.template = templateArtifact;
  h.segment = segmentArtifact;
  localStorage.clear();
  invalidateArtifact(eml);
  invalidateArtifact(seg);
  invalidateArtifact(bct);
});

afterEach(cleanup);

describe('one exact preview read across the whole review (#498 review)', () => {
  it('reads an e-mail preview and its checks once for the summary and the renderer', async () => {
    renderDrawer(templateDetail);
    expect(await screen.findByText('Preview subject')).toBeTruthy();
    await waitFor(() => expect(count('templates.check')).toBe(1));
    expect(count('templates.preview')).toBe(1);
    expect(count('templates.check')).toBe(1);
  });

  it('reads a broadcast audience once and never fans out to an unselected segment preview', async () => {
    renderDrawer(broadcastDetail);
    expect(await screen.findByText('Eligible in current check')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/1,842 in current check/)).toBeTruthy());
    expect(count('broadcasts.preview')).toBe(1);
    expect(count('segments.preview')).toBe(0);
  });

  it('reads a segment count once and offers one explicit Refresh path', async () => {
    renderDrawer(segmentDetail);
    expect((await screen.findAllByText(/1,842/)).length).toBeGreaterThan(0);
    expect(count('segments.preview')).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(count('segments.preview')).toBe(2));
    expect((await screen.findAllByText(/1,842/)).length).toBeGreaterThan(0);
  });
});
