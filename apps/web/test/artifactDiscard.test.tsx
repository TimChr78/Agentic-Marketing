import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactDetailPage } from '../src/features/artifacts/ArtifactDetailPage';
import { ToastProvider } from '../src/ui/toast';

const fixture = vi.hoisted(() => ({
  id: `not_${'a'.repeat(32)}`,
  type: 'note',
  name: 'Saved note',
  latestVersion: 1,
  publishedVersion: null,
  version: {
    number: 1,
    state: 'draft',
    content: { title: 'Saved', body: 'Original' },
    contentHash: 'hash',
    author: { type: 'user', id: 'owner' },
    createdAt: '2026-11-04T12:00:00Z',
  },
}));
vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return { ...actual, api: { call: vi.fn(async (command: string) => (command === 'artifacts.get' ? fixture : { approvals: [] })) } };
});
vi.mock('../src/app/session', () => ({ useWorkspace: () => ({ can: () => true, workspace: { approvalPolicy: 'none' } }) }));
afterEach(cleanup);

it('Discard changes resets an invalid local JSON buffer to the saved document (#384)', async () => {
  render(
    <ToastProvider>
      <ArtifactDetailPage id={fixture.id} crumbs={[]} preview={false} />
    </ToastProvider>,
  );
  const input = await screen.findByLabelText('Content (JSON)');
  fireEvent.change(input, { target: { value: '{"title":"Changed","body":"Original"}' } });
  expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
  fireEvent.change(input, { target: { value: '{"title":' } });
  expect(screen.getByText(/Not valid JSON yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  await waitFor(() =>
    expect((screen.getByLabelText('Content (JSON)') as HTMLTextAreaElement).value).toBe(JSON.stringify(fixture.version.content, null, 2)),
  );
  expect(screen.queryByText(/Not valid JSON yet/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
});
