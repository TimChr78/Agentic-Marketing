import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #498 review: every bundle member shows a compact consequence summary before the selected
// member's detail. It comes from that member's exact approvals.get response only: no audience
// previews for members the reviewer has not selected.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  members: {} as Record<string, unknown>,
  failMember: null as string | null,
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'approvals.get') {
          const id = String(input.approvalId);
          if (h.failMember === id) return Promise.reject(new Error('Member read failed.'));
          const member = h.members[id];
          if (!member) throw new Error(`unexpected approval ${id}`);
          return Promise.resolve(member);
        }
        if (name === 'artifacts.get') {
          if (input.artifactId === eml) return Promise.resolve(templateArtifact);
          if (input.artifactId === seg) return Promise.resolve(segmentArtifact);
          throw new Error(`unexpected artifact ${String(input.artifactId)}`);
        }
        if (name === 'templates.preview')
          return Promise.resolve({
            version: 4,
            subject: 'Bundle template',
            preheader: '',
            html: '<html><body><p>Bundle body</p></body></html>',
            text: 'Bundle body',
            warnings: [],
          });
        if (name === 'templates.check')
          return Promise.resolve({
            version: 4,
            findings: [],
            checkedAt: '2026-11-06T10:32:00Z',
            summary: { blocking: 0, warning: 0, info: 0 },
          });
        if (name === 'broadcasts.preview')
          return Promise.resolve({
            audience: 100,
            checked: 100,
            wouldSend: 90,
            wouldSkip: {},
            sendAt: null,
            sendWindow: null,
            subjectTest: null,
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
  artifactLatestVersion: 1,
  artifactPublishedVersion: null,
  publishedVersion: null,
  reviewUrl: null,
  bundle: null,
  publishedContent: null,
  diff: { from: null, to: 1, changes: [] },
  history: [],
};

const bundle = {
  id: 'bnd_1',
  members: [
    { approvalId: 'apr_broadcast', artifactId: bct, artifactName: 'Bundle send', artifactType: 'broadcast', version: 1 },
    { approvalId: 'apr_template', artifactId: eml, artifactName: 'Bundle template', artifactType: 'email_template', version: 4 },
    { approvalId: 'apr_segment', artifactId: seg, artifactName: 'Bundle segment', artifactType: 'segment', version: 2 },
  ],
};

const broadcastDetail = {
  ...base,
  id: 'apr_broadcast',
  artifactId: bct,
  artifactName: 'Bundle send',
  artifactType: 'broadcast',
  version: 1,
  bundle,
  content: { template: eml, segment: seg, sendAt: '2026-12-01T09:00:00Z' },
};

const templateDetail = {
  ...base,
  id: 'apr_template',
  artifactId: eml,
  artifactName: 'Bundle template',
  artifactType: 'email_template',
  version: 4,
  bundle,
  content: { purpose: 'marketing_email', subject: 'Bundle subject', preheader: '', mjml: '<mjml><mj-body /></mjml>' },
};

const segmentDetail = {
  ...base,
  id: 'apr_segment',
  artifactId: seg,
  artifactName: 'Bundle segment',
  artifactType: 'segment',
  version: 2,
  bundle,
  content: { description: 'Engaged', condition: { consent: 'marketing_email' } },
};

const templateArtifact = {
  id: eml,
  type: 'email_template',
  name: 'Bundle template',
  latestVersion: 4,
  publishedVersion: 4,
  version: { number: 4, state: 'published', content: { purpose: 'marketing_email' } },
  layout: null,
  references: [],
};

const segmentArtifact = {
  id: seg,
  type: 'segment',
  name: 'Bundle segment',
  latestVersion: 2,
  publishedVersion: 2,
  version: { number: 2, state: 'published', content: {} },
  layout: null,
  references: [],
};

function renderDrawer() {
  return render(
    <ToastProvider>
      <ApprovalDrawer id="apr_broadcast" queue={['apr_broadcast']} onClose={() => {}} onDecided={() => {}} />
    </ToastProvider>,
  );
}

const count = (name: string) => h.calls.filter((c) => c.name === name).length;

beforeEach(() => {
  h.calls.length = 0;
  h.failMember = null;
  h.members = { apr_broadcast: broadcastDetail, apr_template: templateDetail, apr_segment: segmentDetail };
  localStorage.clear();
  invalidateArtifact(eml);
  invalidateArtifact(seg);
  invalidateArtifact(bct);
});

afterEach(cleanup);

describe('bundle member consequence summaries (#498 review)', () => {
  it('shows what each member publishes, when, and its audience/consent changes before the selected detail', async () => {
    renderDrawer();
    const region = await screen.findByRole('region', { name: 'Reviewed together' });
    expect(await within(region).findByText('Membership: dynamic condition')).toBeTruthy();
    expect(within(region).getByText('Purpose: marketing_email')).toBeTruthy();
    expect(within(region).getByText(/Audience: segment seg_/)).toBeTruthy();
    expect(within(region).getByText(/Dec 1, 2026/)).toBeTruthy();
    expect(within(region).getByText(/Publishing alone sends nothing/)).toBeTruthy();
    expect(within(region).getByText(/Membership is not consent/)).toBeTruthy();

    // The member summaries stay before the selected member's full "If approved" consequence detail.
    const heading = screen.getByRole('heading', { name: 'If approved' });
    expect(region.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No audience read is triggered for the unselected segment member.
    expect(count('segments.preview')).toBe(0);
    expect(count('broadcasts.preview')).toBe(1);
  });

  it('keeps a failed member row with its retry instead of dropping it', async () => {
    h.failMember = 'apr_segment';
    renderDrawer();
    const region = await screen.findByRole('region', { name: 'Reviewed together' });
    expect(await within(region).findByText('Member summary unavailable.')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Bundle segment' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
