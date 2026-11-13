// 0.14.13 review (P2): a focus re-check and the explicit "Refresh checks" read share the template
// cache, so an older response that lands last must not put the composer back on a stale pointer.
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = `eml_${'a'.repeat(32)}`;

const artifact = (publishedVersion: number) => ({
  id: A,
  type: 'email_template',
  name: 'Weekly Signal',
  latestVersion: publishedVersion,
  publishedVersion,
  layout: null,
  references: [],
  version: {
    number: publishedVersion,
    state: 'published',
    content: { purpose: 'marketing_email', topic: 'newsletter' },
    contentHash: `hash${publishedVersion}`,
    author: { type: 'user', id: 'u1' },
    by: { kind: 'person', displayName: 'Sam Rivera', personName: 'Sam Rivera', tokenName: null, tokenId: null, clientName: null },
    note: null,
    basedOn: null,
    createdAt: '2026-11-02T09:00:00.000Z',
  },
});

interface Pending {
  artifactId: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const h = vi.hoisted(() => ({ pending: [] as Pending[] }));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(
        (name: string, input: Record<string, unknown> = {}) =>
          new Promise((resolve, reject) => {
            if (name !== 'artifacts.get') {
              reject(new Error(`unexpected command ${name}`));
              return;
            }
            h.pending.push({ artifactId: String(input.artifactId ?? ''), resolve, reject });
          }),
      ),
    },
  };
});

import { useSharedArtifact } from '../src/features/broadcasts/composer/useComposerData';

const settle = async (index: number, version: number) => {
  await act(async () => {
    h.pending[index]!.resolve(artifact(version));
  });
};

const flush = () => act(async () => {});

beforeEach(() => {
  h.pending.length = 0;
});

describe('the composer template read commits only its latest request (0.14.13 review)', () => {
  it('keeps the newer focus read when an older one resolves last', async () => {
    const { result } = renderHook(() => useSharedArtifact(A));
    expect(h.pending).toHaveLength(1);
    await settle(0, 1);
    await waitFor(() => expect(result.current.artifact?.publishedVersion).toBe(1));

    // Two focus returns before either read answers: v3 is requested after v2.
    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    // A second return: the person left the window in between (one return reads once, #735).
    act(() => window.dispatchEvent(new Event('blur')));
    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    expect(h.pending).toHaveLength(3);

    await settle(2, 3);
    await waitFor(() => expect(result.current.artifact?.publishedVersion).toBe(3));
    // The older read (v2) lands after the newer one (v3); it must not restore v2.
    await settle(1, 2);
    await flush();
    expect(result.current.artifact?.publishedVersion).toBe(3);
  });

  it('does not let a focus read pending across an explicit refresh overwrite the refresh', async () => {
    const { result, rerender } = renderHook(({ refreshKey }) => useSharedArtifact(A, refreshKey), {
      initialProps: { refreshKey: 0 },
    });
    await settle(0, 1);
    await waitFor(() => expect(result.current.artifact?.publishedVersion).toBe(1));

    // A focus read is in flight when "Refresh checks" starts its own read.
    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    expect(h.pending).toHaveLength(2);
    rerender({ refreshKey: 1 });
    await flush();
    expect(h.pending).toHaveLength(3);

    await settle(2, 3);
    await waitFor(() => expect(result.current.artifact?.publishedVersion).toBe(3));
    // The older focus read answers with v2 after the refresh; the refresh stays authoritative.
    await settle(1, 2);
    await flush();
    expect(result.current.artifact?.publishedVersion).toBe(3);
  });

  it('clears loading when a focus read during the StrictMode mount is the latest', async () => {
    // The reviewer's repro: the mount reads and a focus re-check are all replaced by one shared
    // sequence. The focus read answers first and commits; the effect's completion is suppressed.
    // Loading belongs to whichever read commits last, so the focus read must clear it.
    const { result } = renderHook(() => useSharedArtifact(A), { wrapper: StrictMode });
    expect(result.current.loading).toBe(true);
    expect(h.pending.length).toBeGreaterThanOrEqual(1);

    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    const focus = h.pending.length - 1;
    await settle(focus, 2);
    expect(result.current.artifact?.publishedVersion).toBe(2);
    expect(result.current.loading).toBe(false);

    // Both mount responses land after the focus read. They are older and must neither win nor
    // switch loading back on.
    for (let i = 0; i < focus; i++) await settle(i, 1);
    await flush();
    expect(result.current.artifact?.publishedVersion).toBe(2);
    expect(result.current.loading).toBe(false);
  });

  it('clears loading and shows the error when the latest read fails', async () => {
    const { result } = renderHook(() => useSharedArtifact(A), { wrapper: StrictMode });
    act(() => window.dispatchEvent(new Event('focus')));
    await flush();
    const focus = h.pending.length - 1;
    await act(async () => {
      h.pending[focus]!.reject(new Error('offline'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('offline');

    // The superseded mount responses must not clear the error or re-set loading.
    for (let i = 0; i < focus; i++) await settle(i, 1);
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('offline');
  });

  it('updates no state after the hook unmounts', async () => {
    // A render count, not console silence: a setState after unmount would re-render in some React
    // versions, and the hook must not even try.
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders++;
      return useSharedArtifact(A);
    });
    expect(h.pending).toHaveLength(1);
    unmount();
    const settled = renders;
    await settle(0, 2);
    await flush();
    expect(renders).toBe(settled);
  });
});
