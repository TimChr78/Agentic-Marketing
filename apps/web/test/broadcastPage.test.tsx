import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateArtifact } from '../src/features/artifactCache';
import { clearArtifactNameCache } from '../src/features/broadcasts/names';
import BroadcastPage from '../src/pages/build/BroadcastPage';
import { ToastProvider } from '../src/ui/toast';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown }[],
  artifact: null as unknown,
  status: null as unknown,
  approvals: null as null | (() => Promise<unknown>),
  can: (_permission: string): boolean => true,
}));

const id = `bct_${'a'.repeat(32)}`;
const idB = `bct_${'d'.repeat(32)}`;
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

const artifactB = {
  ...artifact,
  id: idB,
  name: 'Second broadcast',
};

const statusB = {
  ...status,
  run: {
    ...status.run,
    status: 'running',
    version: 1,
    finishedAt: null,
  },
  delivery: { queued: 100 },
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
          if (input.artifactId === idB) return artifactB;
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
        if (name === 'broadcasts.status') {
          if (input.artifactId === idB) return statusB;
          return (h.status as typeof status | null) ?? status;
        }
        if (name === 'approvals.list') return (await h.approvals?.()) ?? { approvals: [] };
        if (name === 'campaigns.of') return { campaigns: [] };
        if (name === 'purposes.list')
          return {
            source: 'published',
            purposes: [
              {
                key: 'marketing_email',
                name: 'Marketing e-mail',
                description: '',
                basis: 'consent',
                channels: ['email'],
                requiresDoubleOptIn: false,
                topics: [{ key: 'newsletter', name: 'Weekly newsletter', description: '', default: 'subscribed' }],
              },
            ],
          };
        if (name === 'system.status')
          return {
            serverVersion: '0.11.0',
            emailProvider: { configured: true, marketing: true, transactional: true, adapter: 'ses', tracking: 'configurable' },
            pendingApprovals: 0,
          };
        if (name === 'sendingDomains.list')
          return {
            checkedAt: '2026-11-06T10:32:00Z',
            domains: [
              {
                domain: 'mail.martechsignal.example',
                ok: true,
                uses: ['marketing', 'transactional'],
                spf: { ok: true, record: 'v=spf1', advice: null },
                dmarc: { ok: true, record: 'v=DMARC1', policy: 'none', advice: null },
                dkim: [],
              },
            ],
          };
        if (name === 'broadcasts.preview')
          return {
            audience: 12480,
            checked: 2000,
            wouldSend: 1842,
            wouldSkip: { no_consent: 110 },
            sendAt: null,
            sendWindow: null,
            subjectTest: null,
          };
        if (name === 'templates.preview')
          return { version: 5, subject: 'Field notes', preheader: '', html: '<html><body>Hi</body></html>', text: 'Hi', warnings: [] };
        if (name === 'templates.check')
          return { version: 5, findings: [], checkedAt: '2026-11-06T10:32:00Z', summary: { blocking: 0, warning: 0, info: 0 } };
        if (name === 'analytics.query') return analytics;
        if (name === 'archive.issues') return { issues: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/components/Chart', () => ({ Chart: () => null }));

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({
    can: (permission: string) => h.can(permission),
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
  h.can = (permission) => permission !== 'messages:send';
  clearArtifactNameCache();
  invalidateArtifact(tpl);
  invalidateArtifact(seg);
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
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'analytics.query')).toHaveLength(2));

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
    expect(screen.queryByText('Sent people')).toBeNull();
    expect(h.calls.filter((c) => c.name === 'analytics.query')).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
    expect(await screen.findByText('Sent people')).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'analytics.query')).toHaveLength(2);
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

  it('resets the tab and run state when the broadcast id changes (#485)', async () => {
    const { rerender } = render(
      <ToastProvider>
        <BroadcastPage params={{ id }} />
      </ToastProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Report' }).getAttribute('aria-selected')).toBe('true'));

    // A person chooses a tab on A; it must not follow them to B.
    fireEvent.click(screen.getByRole('tab', { name: 'Content' }));
    expect(location.search).toBe('?tab=content');

    // Open B from Recents: no ?tab, and B is running, so its default is Sending.
    history.replaceState(null, '', `/build/broadcasts/${idB}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    rerender(
      <ToastProvider>
        <BroadcastPage params={{ id: idB }} />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Second broadcast' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Sending' }).getAttribute('aria-selected')).toBe('true'));

    // An explicit ?tab= still wins on the new broadcast.
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(location.search).toBe('?tab=versions');
  });

  it('waits for the send state before offering publish or submit (#484)', async () => {
    h.artifact = draftArtifact;
    let release!: (value: unknown) => void;
    h.status = new Promise((resolve) => {
      release = resolve;
    });
    h.approvals = async () => ({ approvals: [] });
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' });

    // The status read is in flight: an unknown run is not a draft with no run.
    expect(screen.queryByRole('button', { name: 'Publish v2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
    const checking = screen.getByRole('button', { name: 'Checking send state' }) as HTMLButtonElement;
    expect(checking.disabled).toBe(true);

    await act(async () => release(notRunStatus));
    expect(await screen.findByRole('button', { name: 'Publish v2' })).toBeTruthy();
  });

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

  it('renders the composer on the Content tab while the Report tab keeps its own reads', async () => {
    history.replaceState(null, '', `/build/broadcasts/${id}?tab=content`);
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' });

    expect(await screen.findByText('Live preview')).toBeTruthy();
    expect(screen.getByText('Pre-send checks')).toBeTruthy();
    expect(screen.getByText('1 · What')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Jump to preview' })).toBeTruthy();
    expect(h.calls.filter((call) => call.name === 'broadcasts.status')).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
    expect(await screen.findByText('Sent people')).toBeTruthy();
    expect(h.calls.filter((call) => call.name === 'analytics.query')).toHaveLength(2);
  });

  it('skips every composer read and shows the restricted page without artifacts:read', async () => {
    h.can = () => false;
    renderPage();
    expect(await screen.findByText('Broadcasts are restricted')).toBeTruthy();
    expect(screen.queryByText('Live preview')).toBeNull();
    expect(h.calls.filter((call) => call.name === 'artifacts.get')).toHaveLength(0);
    expect(h.calls.filter((call) => call.name === 'purposes.list')).toHaveLength(0);
    expect(h.calls.filter((call) => call.name === 'system.status')).toHaveLength(0);
    expect(h.calls.filter((call) => call.name === 'broadcasts.preview')).toHaveLength(0);
  });

  it('keeps the composer inspectable but disabled without artifacts:write', async () => {
    h.can = (permission) => permission === 'artifacts:read';
    h.artifact = draftArtifact;
    h.status = notRunStatus;
    h.approvals = async () => ({ approvals: [] });
    history.replaceState(null, '', `/build/broadcasts/${id}?tab=content`);
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Lifecycle playbook' });

    expect(await screen.findByText('Your role can read this broadcast but cannot edit it.')).toBeTruthy();
    expect((screen.getByLabelText(/Template/) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Segment/) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View content' })).toBeTruthy();
  });
});
