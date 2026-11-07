import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #498 review: the block previews must represent the reviewed publication. The combined server
// render expands published block vN only, so a bundled block vN+1 cannot be shown as the message;
// each block is previewed at its bundle override or its exact published version instead.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  detail: null as unknown,
  blockRefs: {} as Record<string, { publishedVersion: number | null }>,
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
          const id = String(input.artifactId);
          const ref = h.blockRefs[id];
          if (!ref) throw new Error(`unexpected artifact ${id}`);
          return Promise.resolve({
            id,
            type: 'email_block',
            name: `Block ${id.slice(-4)}`,
            latestVersion: ref.publishedVersion ?? 3,
            publishedVersion: ref.publishedVersion,
            version: { number: ref.publishedVersion ?? 3, state: 'published', content: {} },
            layout: null,
            references: [],
          });
        }
        if (name === 'blocks.preview')
          return Promise.resolve({
            version: Number(input.version ?? 1),
            html: `<html><body><p>Block at ${input.version}</p></body></html>`,
            warnings: [],
          });
        if (name === 'blocks.usage') return Promise.resolve({ templates: [] });
        if (name === 'templates.preview')
          return Promise.resolve({
            version: Number(input.version ?? 1),
            subject: 'Template subject',
            preheader: '',
            html: '<html><body><p>Template body</p></body></html>',
            text: 'Template body',
            warnings: [],
          });
        if (name === 'templates.check')
          return Promise.resolve({
            version: Number(input.version ?? 1),
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
import { invalidateArtifact } from '../src/features/artifactCache';
import { ToastProvider } from '../src/ui/toast';

const eml = `eml_${'a'.repeat(32)}`;
const blkBundle = `blk_${'b'.repeat(32)}`;
const blkPublished = `blk_${'c'.repeat(32)}`;
const blkExact = `blk_${'d'.repeat(32)}`;

const requester = {
  kind: 'person' as const,
  displayName: 'Sam Builder',
  personName: 'Sam Builder',
  tokenName: null,
  clientName: null,
};

function templateDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apr_template',
    artifactId: eml,
    artifactName: 'Block bundle template',
    artifactType: 'email_template',
    version: 2,
    status: 'pending',
    requestedBy: { type: 'user', id: 'usr_builder' },
    requester,
    note: 'Please review the bundled block.',
    decidedBy: null,
    decisionNote: null,
    createdAt: '2026-11-06T09:00:00.000Z',
    holdUntil: null,
    artifactLatestVersion: 2,
    artifactPublishedVersion: 1,
    publishedVersion: 1,
    reviewUrl: null,
    bundle: {
      id: 'bnd_1',
      members: [
        { approvalId: 'apr_template', artifactId: eml, artifactName: 'Block bundle template', artifactType: 'email_template', version: 2 },
        { approvalId: 'apr_block', artifactId: blkBundle, artifactName: 'Bundled header', artifactType: 'email_block', version: 2 },
      ],
    },
    content: {
      purpose: 'marketing_email',
      subject: 'Bundled blocks',
      preheader: '',
      mjml: `<mjml><mj-body><mj-section><mj-column>{% block '${blkBundle}', title: 'A' %}{% block '${blkPublished}', title: 'B' %}</mj-column></mj-section></mj-body></mjml>`,
    },
    publishedContent: null,
    diff: { from: 1, to: 2, changes: [] },
    history: [],
    ...overrides,
  };
}

function renderDrawer(id: string) {
  return render(
    <ToastProvider>
      <ApprovalDrawer id={id} queue={[id]} onClose={() => {}} onDecided={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  h.calls.length = 0;
  h.detail = null;
  h.blockRefs = {
    [blkBundle]: { publishedVersion: 1 },
    [blkPublished]: { publishedVersion: 3 },
    [blkExact]: { publishedVersion: 4 },
  };
  localStorage.clear();
  invalidateArtifact(blkBundle);
  invalidateArtifact(blkPublished);
  invalidateArtifact(blkExact);
});

afterEach(cleanup);

describe('block previews represent the reviewed publication (#498 review)', () => {
  it('withholds the combined message when a bundled block pin differs, and previews every exact version', async () => {
    h.detail = templateDetail();
    renderDrawer('apr_template');

    expect(await screen.findByText('Bundled block render unavailable before publication')).toBeTruthy();
    expect(screen.getAllByText(/exact reviewed content/).length).toBeGreaterThan(0);
    // The normal combined e-mail frame is not shown as if it were the future bundle message.
    expect(screen.queryByTitle(/^E-mail preview/)).toBeNull();
    // The summary still reads the template once; the withheld combined preview adds no second read.
    expect(h.calls.filter((c) => c.name === 'templates.preview')).toHaveLength(1);

    await waitFor(() => {
      const previews = h.calls.filter((c) => c.name === 'blocks.preview');
      expect(previews.map((c) => c.input.version)).toEqual(expect.arrayContaining([2, 3]));
    });
    const previews = h.calls.filter((c) => c.name === 'blocks.preview');
    // bundled block: its exact bundle override, not the latest draft; unbundled: published v3.
    expect(previews.find((c) => c.input.artifactId === blkBundle)?.input.version).toBe(2);
    expect(previews.find((c) => c.input.artifactId === blkPublished)?.input.version).toBe(3);
    expect((await screen.findAllByText('Published v3')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Saved v2/)).length).toBeGreaterThan(0);
  });

  it('passes the exact version for an unbundled block review', async () => {
    h.detail = {
      ...templateDetail(),
      id: 'apr_block',
      artifactId: blkExact,
      artifactName: 'Exact block',
      artifactType: 'email_block',
      version: 4,
      bundle: null,
      content: { category: 'header', mjml: '<mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section>' },
      diff: { from: 3, to: 4, changes: [] },
    };
    renderDrawer('apr_block');

    await waitFor(() => {
      const preview = h.calls.find((c) => c.name === 'blocks.preview');
      expect(preview?.input.version).toBe(4);
    });
    expect(screen.getByText(/Rendered from version 4/)).toBeTruthy();
  });
});
