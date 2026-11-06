import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearArtifactNameCache } from '../src/features/broadcasts/names';
import BroadcastPage from '../src/pages/build/BroadcastPage';
import { ToastProvider } from '../src/ui/toast';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown }[],
  artifact: null as unknown,
  status: null as unknown,
  approvals: null as null | (() => Promise<unknown>),
}));

const id = `bct_${'a'.repeat(32)}`;
const seg = `seg_${'b'.repeat(32)}`;
const tpl = `eml_${'c'.repeat(32)}`;

const artifact = {
  id,
  type: 'broadcast',
  name: 'Lifecycle playbook',
  latestVersion: 2,
  publishedVersion: 2,
  version: {
    number: 2,
    state: 'published',
    author: { type: 'user', id: 'person_1' },
    by: {
      kind: 'person',
      displayName: 'Alex Morgan',
      personName: 'Alex Morgan',
      tokenName: null,
      tokenId: null,
      clientName: null,
    },
    note: null,
    contentHash: 'hash',
    basedOn: 1,
    createdAt: '2026-11-05T15:20:00Z',
    content: { template: tpl, segment: seg, sendAt: '2026-11-05T16:00:00Z' },
  },
  layout: null,
  references: [tpl, seg],
};

const status = {
  // The run's pinned definition (#449 review): the summary names this segment, not the draft's.
  segmentId: seg,
  templateId: tpl,
  run: {
    status: 'done',
    version: 2,
    sendAt: '2026-11-05T16:00:00Z',
    recipients: 10140,
    queued: 10000,
    skipped: 140,
    windowSkipped: 0,
    startedAt: '2026-11-05T16:00:00Z',
    finishedAt: '2026-11-05T16:12:00Z',
    error: null,
  },
  messages: {},
  delivery: { sent: 9860, queued: 140 },
  test: null,
  stage: null,
};

const analytics = {
  columns: [
    { name: 'email.sent', kind: 'measure', unit: 'count' },
    { name: 'email.delivered', kind: 'measure', unit: 'count' },
    { name: 'email.clicked', kind: 'measure', unit: 'count' },
    { name: 'email.click_rate', kind: 'measure', unit: 'ratio' },
  ],
  rows: [[10140, 9860, 1200, 0.1217]],
  meta: {
    timeZone: 'UTC',
    currency: null,
    from: '2026-10-30T00:00:00.000Z',
    to: '2026-11-06T00:00:00.000Z',
    freshness: '2026-11-05T17:00:00Z',
    suppressed: 0,
    k: 5,
    notes: [],
  },
};

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: { artifactId?: string; status?: string }) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.get') {
          if (input.artifactId === tpl)
            return {
              ...artifact,
              id: tpl,
              type: 'email_template',
              name: 'Field notes',
              publishedVersion: 5,
              latestVersion: 5,
              version: { ...artifact.version, number: 5, content: { purpose: 'marketing_email' } },
            };
          return (h.artifact as typeof artifact | null) ?? artifact;
        }
        if (name === 'artifacts.list') {
          return {
            artifacts: [
              {
                id: seg,
                type: 'segment',
                name: 'Engaged readers',
                latestVersion: 1,
                latestState: 'published',
                publishedVersion: 1,
                updatedAt: '2026-11-06T09:00:00.000Z',
              },
              {
                id: tpl,
                type: 'email_template',
                name: 'Field notes',
                latestVersion: 5,
                latestState: 'published',
                publishedVersion: 5,
                updatedAt: '2026-11-06T09:00:00.000Z',
              },
            ],
            total: 2,
            nextCursor: null,
          };
        }
        if (name === 'broadcasts.status') return (h.status as typeof status | null) ?? status;
        if (name === 'approvals.list') return (await h.approvals?.()) ?? { approvals: [] };
        if (name === 'campaigns.of') return { campaigns: [] };
        if (name === 'purposes.list') return { purposes: [] };
        if (name === 'analytics.query') return analytics;
        if (name === 'archive.issues') return { issues: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({
    can: (permission: string) => permission !== 'messages:send',
    workspace: { id: 'ws_1', approvalPolicy: 'none' },
    user: { id: 'u1' },
  }),
}));

beforeEach(() => {
  cleanup();
  h.calls.length = 0;
  h.artifact = null;
  h.status = null;
  h.approvals = null;
  clearArtifactNameCache();
  history.replaceState(null, '', `/build/broadcasts/${id}`);
});

const renderPage = () =>
  render(
    <ToastProvider>
      <BroadcastPage params={{ id }} />
    </ToastProvider>,
  );

describe('BroadcastPage (#448)', () => {
  it('shares one status read across pill, summary, Sending and context, and defaults to Report for a done run', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' })).toBeTruthy();
    expect(screen.getByText('Broadcast')).toBeTruthy();
    expect(screen.getByText('Delivering')).toBeTruthy();
    expect(screen.getByText('Published v2')).toBeTruthy();
    expect(screen.getByText(/changed by Alex Morgan/)).toBeTruthy();
    expect(screen.getByText(/Engaged readers · 10,140 reached at preparation/)).toBeTruthy();
    expect(screen.getByText('140 messages still waiting for the provider. Inspect sending progress.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View report' })).toBeTruthy();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Report' }).getAttribute('aria-selected')).toBe('true'));
    expect(h.calls.filter((c) => c.name === 'broadcasts.status')).toHaveLength(1);
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'analytics.query')).toHaveLength(1));

    expect(screen.getByText('Context')).toBeTruthy();
    expect(screen.getByText('Alex Morgan')).toBeTruthy();
    expect(screen.getByText(/9,860 provider-accepted/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Sending' }));
    expect((await screen.findAllByText('Current delivery')).length).toBeGreaterThan(1);
    expect(screen.getByText('Messages by their current status, separate from the event totals above.')).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'broadcasts.status')).toHaveLength(1);
  });

  it('loads the report only when its tab is selected', async () => {
    history.replaceState(null, '', `/build/broadcasts/${id}?tab=content`);
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' });
    expect(screen.queryByText('E-mails sent')).toBeNull();
    expect(h.calls.filter((c) => c.name === 'analytics.query')).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
    expect(await screen.findByText('E-mails sent')).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'analytics.query')).toHaveLength(1);
  });

  const draftArtifact = {
    ...artifact,
    publishedVersion: null,
    latestVersion: 2,
    version: { ...artifact.version, number: 2, state: 'draft' },
  };
  const notRunStatus = {
    ...status,
    run: {
      ...status.run,
      status: 'not_scheduled',
      version: null,
      sendAt: null,
      recipients: 0,
      queued: 0,
      skipped: 0,
      startedAt: null,
      finishedAt: null,
    },
  };

  it('shows a retryable error above the tabs and disables submission when the pending read fails', async () => {
    h.artifact = draftArtifact;
    h.status = notRunStatus;
    h.approvals = async () => {
      throw new Error('Approvals unavailable');
    };
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' });

    expect(await screen.findByText('Couldn’t check pending approvals')).toBeTruthy();
    expect(screen.getByText(/Approvals unavailable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish v2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View content' })).toBeTruthy();

    const before = h.calls.filter((c) => c.name === 'approvals.list').length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'approvals.list')).toHaveLength(before + 1));
  });

  it('keeps submission disabled while the pending read is loading, then enables it', async () => {
    h.artifact = draftArtifact;
    h.status = notRunStatus;
    let release!: (value: unknown) => void;
    h.approvals = () => new Promise((resolve) => (release = resolve));
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' });

    expect(screen.queryByRole('button', { name: 'Publish v2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View content' })).toBeTruthy();

    await act(async () => release({ approvals: [] }));
    expect(await screen.findByRole('button', { name: 'Publish v2' })).toBeTruthy();
  });
});
