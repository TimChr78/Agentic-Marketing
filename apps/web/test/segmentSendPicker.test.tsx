import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import { ArtifactDetailPage } from '../src/features/artifacts/ArtifactDetailPage';
import { resetPickerIndexes } from '../src/features/artifacts/pickerIndex';
import { SegmentEditor } from '../src/features/artifacts/SegmentEditor';
import { ToastProvider } from '../src/ui/toast';

// #441 review: picking a kind of send is not a change to the segment. Until a broadcast or journey
// is actually chosen, the saved condition must stay what it was and the page must refuse to save or
// publish the row, with the row's own message. Only "Any send" makes it unrestricted.

const ws = '11111111-1111-4111-8111-111111111111';
const SEG = `seg_${'a'.repeat(32)}`;
const BCT = `bct_${'b'.repeat(32)}`;
const JRN = `jrn_${'c'.repeat(32)}`;

const h = vi.hoisted(() => ({
  saves: [] as { content: unknown }[],
  saved: { description: 'Message engagement', mode: 'dynamic', condition: { message: 'opened', broadcast: `bct_${'b'.repeat(32)}` } },
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        if (name === 'artifacts.get')
          return {
            id: SEG,
            type: 'segment',
            name: 'Engaged readers',
            latestVersion: 2,
            publishedVersion: 1,
            layout: null,
            references: [],
            version: {
              number: 2,
              state: 'draft',
              content: h.saved,
              contentHash: 'hash',
              author: { type: 'user', id: 'u1' },
              by: { kind: 'person', displayName: 'Sam Rivera', personName: 'Sam Rivera', tokenName: null, tokenId: null, clientName: null },
              note: null,
              basedOn: null,
              createdAt: '2026-11-02T09:00:00.000Z',
            },
          };
        if (name === 'artifacts.updateDraft') {
          h.saves.push({ content: input.content });
          h.saved = input.content as typeof h.saved;
          return { artifactId: SEG, version: 2, contentHash: `hash-${h.saves.length}`, warnings: [] };
        }
        if (name === 'purposes.list') return { source: 'published', purposes: [{ key: 'marketing_email', name: 'Marketing e-mail' }] };
        if (name === 'artifacts.list') {
          const artifacts =
            input.type === 'journey'
              ? [{ id: JRN, type: 'journey', name: 'Welcome series', publishedVersion: 3 }]
              : input.type === 'broadcast'
                ? [{ id: BCT, type: 'broadcast', name: 'Weekly Signal #40', publishedVersion: 2 }]
                : [];
          return { artifacts, total: artifacts.length, nextCursor: null };
        }
        return { approvals: [] };
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = {
    can: () => true,
    workspace: { id: '11111111-1111-4111-8111-111111111111', approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  };
  return { useSession: () => session, useWorkspace: () => session };
});

beforeEach(() => {
  h.saves.length = 0;
  h.saved = {
    description: 'Message engagement',
    mode: 'dynamic',
    condition: { message: 'opened', broadcast: BCT },
  };
  resetPickerIndexes();
  setWorkspaceId(ws, { persist: false });
});
afterEach(() => cleanup());

const renderPage = () =>
  render(
    <ToastProvider>
      <ArtifactDetailPage id={SEG} crumbs={[]} preview={false} editor={(p) => <SegmentEditor {...p} />} />
    </ToastProvider>,
  );

const sourceSelect = () => screen.getByRole('combobox', { name: 'Sent from, condition 1' });
const publish = () => screen.queryByRole('button', { name: 'Publish' });
const saveButton = () => screen.queryByRole('button', { name: 'Save draft' });
const lastSaved = () => h.saves.at(-1)?.content as { condition: Record<string, unknown> } | undefined;

it('refuses to save or publish a send that is picked but not chosen, and saves the picked one', async () => {
  renderPage();
  expect(await screen.findByRole('combobox', { name: 'Broadcast, condition 1' })).toBeTruthy();
  expect(publish()).toBeTruthy();

  // A kind of send is only an intent. The saved condition still counts the broadcast, nothing is
  // written, and the page says what the row needs instead of offering Publish.
  fireEvent.change(sourceSelect(), { target: { value: 'journey' } });
  expect(screen.getByRole('combobox', { name: 'Journey, condition 1' })).toBeTruthy();
  // The row says it, and the page lists the same message above the tabs.
  expect(screen.getAllByText('Choose a journey for condition 1.').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('Finish this before saving or publishing')).toBeTruthy();
  await waitFor(() => expect(publish()).toBeNull());
  expect(saveButton()).toBeNull();
  expect(h.saves).toEqual([]);

  // Choosing the journey is the change: it replaces the broadcast and can be saved.
  fireEvent.change(screen.getByRole('combobox', { name: 'Journey, condition 1' }), { target: { value: JRN } });
  await waitFor(() => expect(saveButton()).toBeTruthy());
  fireEvent.click(saveButton()!);
  await waitFor(() => expect(h.saves.length).toBe(1));
  expect(lastSaved()!.condition).toEqual({ message: 'opened', journey: JRN });

  // "Any send" is an explicit choice too: it removes the send and saves unrestricted.
  fireEvent.change(sourceSelect(), { target: { value: 'any' } });
  await waitFor(() => expect(saveButton()).toBeTruthy());
  fireEvent.click(saveButton()!);
  await waitFor(() => expect(h.saves.length).toBe(2));
  expect(lastSaved()!.condition).toEqual({ message: 'opened' });
});
