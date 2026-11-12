// #599: an estimate for segment A that references segment B must stop claiming "Estimated size now"
// when B's published version changes after the request, even though A's own rules were not edited.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import { invalidateArtifact } from '../src/features/artifactCache';
import { resetPickerIndexes } from '../src/features/artifacts/pickerIndex';
import { SegmentEditor } from '../src/features/artifacts/SegmentEditor';
import { ToastProvider } from '../src/ui';

const ws = '11111111-1111-4111-8111-111111111111';
const A = `seg_${'a'.repeat(32)}`;
const B = `seg_${'b'.repeat(32)}`;

type Call = { name: string; input: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  artifacts: {} as Record<string, unknown>,
  resolved: [] as { id: string; version: number; stamp?: string | null }[],
  listStamp: null as string | null,
}));

const artifact = (id: string, name: string, publishedVersion: number | null, mode: 'dynamic' | 'static' = 'dynamic') => ({
  id,
  type: 'segment',
  name,
  latestVersion: publishedVersion ?? 1,
  publishedVersion,
  layout: null,
  references: [],
  version: {
    number: publishedVersion ?? 1,
    state: publishedVersion === null ? 'draft' : 'published',
    content:
      mode === 'dynamic' ? { description: '', mode, condition: { trait: 'city', op: 'eq', value: 'Aarhus' } } : { description: '', mode },
    contentHash: 'hash',
    author: { type: 'user', id: 'u1' },
    by: { kind: 'person', displayName: 'Sam Rivera', personName: 'Sam Rivera', tokenName: null, tokenId: null, clientName: null },
    note: null,
    basedOn: null,
    createdAt: '2026-11-02T09:00:00.000Z',
  },
});

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        h.calls.push({ name, input });
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null };
        if (name === 'artifacts.get') {
          const found = h.artifacts[String(input.artifactId ?? '')];
          if (!found) throw new Error('This item does not exist.');
          return found;
        }
        if (name === 'segments.preview') {
          // Previewing a static list itself reports the membership stamp that moves on an import.
          if (input.artifactId === B) return { count: 42, sample: [], segments: [{ id: B, version: 3, stamp: h.listStamp }] };
          return { count: 42, segments: h.resolved };
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({
    can: () => true,
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  });
  return { useSession: session, useWorkspace: session };
});

const condition = { segment: B };
const editor = (
  <ToastProvider>
    <SegmentEditor
      artifact={artifact(A, 'Aarhus readers', 1) as never}
      content={{ mode: 'dynamic', condition } as never}
      onChange={() => {}}
      readOnly={false}
      errors={{}}
      warnings={[]}
    />
  </ToastProvider>
);

const estimateText = () => screen.getByText('Estimated size now').parentElement?.textContent ?? '';

beforeEach(() => {
  cleanup();
  h.calls.length = 0;
  h.artifacts = {
    [A]: artifact(A, 'Aarhus readers', 1),
    [B]: artifact(B, 'Engaged readers', 3),
  };
  h.resolved = [{ id: B, version: 3 }];
  h.listStamp = null;
  resetPickerIndexes();
  invalidateArtifact(A);
  invalidateArtifact(B);
  setWorkspaceId(ws, { persist: false });
});

afterEach(() => {
  cleanup();
});

describe('segment estimate follows referenced publications (#599)', () => {
  it('turns a current count into a previous estimate when a referenced segment is republished', async () => {
    render(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));

    await waitFor(() => expect(estimateText()).toContain('42 people'));
    expect(h.calls.find((c) => c.name === 'segments.preview')).toBeTruthy();

    // The estimate recorded B at published version 3; B is republished as v4 in another tab.
    h.artifacts[B] = artifact(B, 'Engaged readers', 4);
    act(() => invalidateArtifact(B));

    await waitFor(() => expect(estimateText()).toContain('previous estimate'));
    expect(estimateText()).toContain('42 people');
    expect(estimateText()).toContain('before a referenced segment was republished');
  });

  it('re-checks the referenced versions on focus without an edit', async () => {
    render(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(estimateText()).toContain('42 people'));

    // No local invalidation: another tab republished B, and this window regains focus.
    h.artifacts[B] = artifact(B, 'Engaged readers', 5);
    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(estimateText()).toContain('previous estimate'));
    expect(h.calls.filter((c) => c.name === 'artifacts.get' && c.input.artifactId === B).length).toBeGreaterThan(1);
  });

  it('treats a segment that lost its published version as a change', async () => {
    render(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(estimateText()).toContain('42 people'));

    h.artifacts[B] = artifact(B, 'Engaged readers', null);
    act(() => invalidateArtifact(B));

    await waitFor(() => expect(estimateText()).toContain('previous estimate'));
  });

  it('turns the estimate into a previous estimate when a referenced list gains members (#771)', async () => {
    // B is a static list: an import changes who it holds without any published version moving.
    h.artifacts[B] = artifact(B, 'Partner list', 3, 'static');
    h.listStamp = '2026-11-12T09:00:00.000000Z';
    h.resolved = [{ id: B, version: 3, stamp: h.listStamp }];

    render(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(estimateText()).toContain('42 people'));
    expect(h.calls.some((c) => c.name === 'segments.preview' && c.input.artifactId === B)).toBe(true);

    // A CSV import adds 400 people to B; no publish, no new version, only a newer run stamp.
    h.listStamp = '2026-11-12T09:05:00.000000Z';
    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(estimateText()).toContain('previous estimate'));
    expect(estimateText()).toContain('42 people');
  });
});
