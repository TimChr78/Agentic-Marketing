import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import { ArtifactSelect } from '../src/features/artifacts/ArtifactSelect';
import { resetPickerIndexes } from '../src/features/artifacts/pickerIndex';

// #1251: the copilot's tools create and edit artifacts, but a finished turn never announced the
// change to the in-tab caches #1167 keeps fresh. A draft it created stayed missing from every
// picker and from the Segments, Forms and Experiences lists until a reload.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as unknown[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        if (name === 'artifacts.list') return { artifacts: h.rows, total: h.rows.length, nextCursor: null };
        if (name === 'copilot.conversations') return { conversations: [] };
        if (name === 'agents.list') return { agents: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
    streamFetch: vi.fn(),
  };
});

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_1' } }),
}));

vi.mock('../src/app/capabilities', () => ({
  useCapabilities: () => ({ mutations: true, copilot: true, reason: null }),
  useCopilotAvailable: () => ({ available: true, reason: null }),
}));

import { streamFetch } from '../src/app/api';
import { CopilotDrawer } from '../src/features/copilot/CopilotDrawer';

const conversation = `cop_${'b'.repeat(32)}`;
const row = (i: number) => ({
  id: `seg_${String(i).padStart(32, '0')}`,
  type: 'segment',
  name: `segment ${i}`,
  latestVersion: 1,
  latestState: 'draft' as const,
  publishedVersion: null,
  updatedAt: '2026-11-02T09:00:00.000Z',
  archived: false,
});
const listReads = () => h.calls.filter((name) => name === 'artifacts.list').length;

beforeEach(() => {
  resetPickerIndexes();
  h.calls.length = 0;
  h.rows = [row(1)];
  setWorkspaceId('11111111-1111-4111-8111-111111111111', { persist: false });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.mocked(streamFetch).mockReset();
});

describe('a Copilot turn that creates an artifact (#1251)', () => {
  it('refreshes the loaded picker index when the turn ends', async () => {
    // The segment index is loaded before the turn, as it is for anyone who opened a picker or the
    // Segments list earlier in the session.
    const picker = render(<ArtifactSelect type="segment" value={undefined} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'segment 1 · not live yet' })).toBeTruthy());
    expect(listReads()).toBe(1);

    const created = row(2);
    h.rows = [row(1), created];
    vi.mocked(streamFetch).mockResolvedValue(
      new Response(
        [
          JSON.stringify({ type: 'conversation', id: conversation, title: 'Draft a win-back segment' }),
          JSON.stringify({ type: 'user', text: 'Draft a win-back segment for people who have not ordered in 90 days' }),
          JSON.stringify({ type: 'tool', id: 't1', name: 'artifacts.create', input: { type: 'segment', name: 'segment 2' } }),
          JSON.stringify({ type: 'toolResult', id: 't1', name: 'artifacts.create', ok: true, output: { artifactId: created.id } }),
          JSON.stringify({ type: 'text', text: 'Created the draft segment.' }),
          JSON.stringify({ type: 'done', conversationId: conversation, usage: { inputTokens: 20, outputTokens: 5 } }),
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      ),
    );
    render(<CopilotDrawer open onClose={() => {}} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Draft a win-back segment for people who have not ordered in 90 days' }),
    );
    expect(await screen.findByText('Created the draft segment.')).toBeTruthy();

    // The turn announced the create, so the mounted picker re-read and shows the new draft.
    await waitFor(() => expect(screen.getByRole('option', { name: 'segment 2 · not live yet' })).toBeTruthy());
    expect(listReads()).toBeGreaterThan(1);

    // A picker opened afterwards uses the refreshed index, not the pre-turn rows.
    picker.unmount();
    render(<ArtifactSelect type="segment" value={undefined} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'segment 2 · not live yet' })).toBeTruthy());
  });
});
