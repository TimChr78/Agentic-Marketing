import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearArtifactNameCache } from '../src/features/broadcasts/names';
import BroadcastsPage from '../src/pages/build/BroadcastsPage';
import { ToastProvider } from '../src/ui/toast';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown }[],
  failSecondPage: false,
  segmentName: 'Engaged readers',
}));

const seg = `seg_${'b'.repeat(32)}`;
const tpl = `eml_${'c'.repeat(32)}`;

function row(name: string, status: 'scheduled' | 'running', id: string) {
  return {
    artifactId: id,
    name,
    latestVersion: 1,
    latestState: 'published',
    publishedVersion: 1,
    updatedAt: '2026-11-06T09:00:00.000Z',
    run: {
      status,
      version: 1,
      sendAt: '2026-11-06T14:00:00Z',
      recipients: status === 'running' ? 100 : 10140,
      queued: status === 'running' ? 100 : 10000,
      skipped: 0,
      windowSkipped: 0,
      startedAt: status === 'running' ? '2026-11-06T10:02:00Z' : null,
      finishedAt: null,
      error: null,
    },
    segmentId: seg,
    templateId: tpl,
    stage: null,
    delivery: {},
  };
}

const first = row('Signal Weekly · issue 128', 'scheduled', `bct_${'1'.repeat(32)}`);
const second = row('November product notes', 'running', `bct_${'2'.repeat(32)}`);
const third = row('Second page issue', 'scheduled', `bct_${'3'.repeat(32)}`);

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: { cursor?: string; statuses?: string[] }) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.list') {
          return {
            artifacts: [
              {
                id: seg,
                type: 'segment',
                name: h.segmentName,
                latestVersion: 1,
                latestState: 'published',
                publishedVersion: 1,
                updatedAt: '2026-11-06T09:00:00.000Z',
              },
            ],
            total: 1,
            nextCursor: null,
          };
        }
        if (name === 'broadcasts.list') {
          if (input.cursor === 'c2' && h.failSecondPage) throw new Error('network down');
          if (input.cursor === 'c2') return { broadcasts: [third], total: 30, nextCursor: 'c3', asOf: '2026-11-06T10:20:00.000Z' };
          if (input.cursor === 'c3') return { broadcasts: [], total: 30, nextCursor: null, asOf: '2026-11-06T10:20:00.000Z' };
          if (input.statuses?.includes('running'))
            return { broadcasts: [second], total: 1, nextCursor: null, asOf: '2026-11-06T10:20:00.000Z' };
          return { broadcasts: [first, second], total: 30, nextCursor: 'c2', asOf: '2026-11-06T10:20:00.000Z' };
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({ can: () => true, workspace: { id: 'ws_1', approvalPolicy: 'none' }, user: { id: 'u1' } }),
}));

beforeEach(() => {
  cleanup();
  h.calls.length = 0;
  h.failSecondPage = false;
  h.segmentName = 'Engaged readers';
  clearArtifactNameCache();
  history.replaceState(null, '', '/build/broadcasts');
});

const renderPage = () =>
  render(
    <ToastProvider>
      <BroadcastsPage />
    </ToastProvider>,
  );

describe('BroadcastsPage (#448)', () => {
  it('makes one broadcasts.list call, no per-row broadcasts.status, and renders the rows', async () => {
    renderPage();
    expect((await screen.findAllByText('Signal Weekly · issue 128')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('November product notes')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Engaged readers').length).toBeGreaterThan(0);
    expect(screen.getByText('30 broadcasts')).toBeTruthy();

    const listCalls = h.calls.filter((c) => c.name === 'broadcasts.list');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.input).toEqual({ limit: 25 });
    expect(h.calls.some((c) => c.name === 'broadcasts.status')).toBe(false);
    // The segment names arrive from one cached artifacts.list read, not one per row.
    const nameCalls = h.calls.filter((c) => c.name === 'artifacts.list');
    expect(nameCalls).toHaveLength(1);
    expect(nameCalls[0]!.input).toEqual({ type: 'segment', limit: 200 });
  });

  it('Refresh re-reads segment names after a rename outside this tab (#459)', async () => {
    renderPage();
    expect((await screen.findAllByText('Engaged readers')).length).toBeGreaterThan(0);

    h.segmentName = 'Engaged readers · November';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findAllByText('Engaged readers · November')).length).toBeGreaterThan(0);
    expect(h.calls.filter((c) => c.name === 'artifacts.list')).toHaveLength(2);
  });

  it('pages with the opaque cursor and allows going back', async () => {
    renderPage();
    await screen.findAllByText('Signal Weekly · issue 128');
    expect(screen.getByText('1–2 of 30 broadcasts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findAllByText('Second page issue')).length).toBeGreaterThan(0);
    const nextCall = h.calls.filter((c) => c.name === 'broadcasts.list').at(-1);
    expect(nextCall!.input).toEqual({ limit: 25, cursor: 'c2' });
    expect(screen.getByText('26–26 of 30 broadcasts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect((await screen.findAllByText('Signal Weekly · issue 128')).length).toBeGreaterThan(0);
    expect(screen.getByText('1–2 of 30 broadcasts')).toBeTruthy();
  });

  it('a second Next before the page arrives does not request the same cursor twice', async () => {
    renderPage();
    await screen.findAllByText('Signal Weekly · issue 128');

    const next = screen.getByRole('button', { name: 'Next' });
    fireEvent.click(next);
    fireEvent.click(next);
    await screen.findAllByText('Second page issue');

    const calls = h.calls.filter((c) => c.name === 'broadcasts.list');
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)!.input).toEqual({ limit: 25, cursor: 'c2' });
  });

  it('after a failed page, Previous and the filter work again and Next stays off (#442 re-review)', async () => {
    h.failSecondPage = true;
    renderPage();
    await screen.findAllByText('Signal Weekly · issue 128');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Couldn’t load broadcasts')).toBeTruthy();

    // The failed page has no Next; the way back and the filter are open.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    const previous = screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(false);
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false);

    h.failSecondPage = false;
    fireEvent.click(previous);
    expect((await screen.findAllByText('Signal Weekly · issue 128')).length).toBeGreaterThan(0);
  });

  it('a later empty page says the page is empty, not that no broadcasts exist', async () => {
    renderPage();
    await screen.findAllByText('Signal Weekly · issue 128');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findAllByText('Second page issue');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('This page is empty')).toBeTruthy();
    expect(screen.queryByText('No broadcasts yet')).toBeNull();
  });

  it('changes the status filter, resets paging and stores only the status in the URL', async () => {
    renderPage();
    await screen.findAllByText('Signal Weekly · issue 128');

    fireEvent.change(screen.getByLabelText('Broadcast status'), { target: { value: 'running' } });
    await waitFor(() => {
      const filtered = h.calls.filter((c) => c.name === 'broadcasts.list').at(-1);
      expect(filtered!.input).toEqual({ limit: 25, statuses: ['running'] });
    });
    expect(location.search).toBe('?status=running');
    await waitFor(() => expect(screen.queryByText('Signal Weekly · issue 128')).toBeNull());
    expect((await screen.findAllByText('November product notes')).length).toBeGreaterThan(0);
  });

  it('consumes ?create=broadcast as the existing create form', async () => {
    history.replaceState(null, '', '/build/broadcasts?create=broadcast');
    renderPage();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New broadcast' })).toBeTruthy();
    expect(within(dialog).getByLabelText(/Template/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/Segment/)).toBeTruthy();
    expect(location.search).not.toContain('create');
  });
});
