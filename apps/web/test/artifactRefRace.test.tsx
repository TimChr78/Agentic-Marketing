// 0.14.13 review (P2): an invalidation read is a promise like any other. Once the selected
// reference moved, or the hook unmounted, an older response must not commit its artifact.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetArtifact, invalidateArtifact, useArtifactNames, useArtifactRef } from '../src/features/artifactCache';

const A = `frm_${'a'.repeat(32)}`;
const B = `frm_${'b'.repeat(32)}`;

const artifact = (id: string, name: string, publishedVersion: number) => ({
  id,
  type: 'form',
  name,
  latestVersion: publishedVersion,
  publishedVersion,
  layout: null,
  references: [],
  version: {
    number: publishedVersion,
    state: 'published',
    content: { description: '' },
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

const settle = async (index: number, value: unknown) => {
  await act(async () => {
    h.pending[index]!.resolve(value);
  });
};

const flush = () => act(async () => {});

function Ref({ id }: { id: string }) {
  const { artifact: a } = useArtifactRef(id);
  return <p>{a ? `${a.name} v${a.publishedVersion}` : 'loading'}</p>;
}

function Names({ ids }: { ids: string[] }) {
  const name = useArtifactNames(ids);
  return <p>{ids.map((id) => name(id) ?? '…').join(', ')}</p>;
}

beforeEach(() => {
  h.pending.length = 0;
  forgetArtifact(A);
  forgetArtifact(B);
});

afterEach(cleanup);

describe('artifact reference reads commit only their latest request (0.14.13 review)', () => {
  it('does not show the previous reference when its invalidation read resolves after the switch', async () => {
    const { rerender } = render(<Ref id={A} />);
    await settle(0, artifact(A, 'Alpha', 1));
    expect(await screen.findByText('Alpha v1')).toBeTruthy();

    // Invalidate A, then switch the mounted component to B before A's re-read answers.
    act(() => invalidateArtifact(A));
    await flush();
    expect(h.pending).toHaveLength(2);
    rerender(<Ref id={B} />);
    await flush();
    expect(h.pending).toHaveLength(3);
    expect(h.pending.map((pending) => pending.artifactId)).toEqual([A, A, B]);

    await settle(2, artifact(B, 'Beta', 2));
    expect(await screen.findByText('Beta v2')).toBeTruthy();

    // A's delayed refresh lands last; the pill must keep describing the selected reference B.
    await settle(1, artifact(A, 'Alpha renamed', 3));
    await flush();
    expect(screen.getByText('Beta v2')).toBeTruthy();
    expect(screen.queryByText('Alpha renamed v3')).toBeNull();
  });

  it('keeps the newer invalidation read when an older one resolves last', async () => {
    render(<Ref id={A} />);
    await settle(0, artifact(A, 'Alpha', 1));
    expect(await screen.findByText('Alpha v1')).toBeTruthy();

    act(() => invalidateArtifact(A));
    await flush();
    act(() => invalidateArtifact(A));
    await flush();
    expect(h.pending).toHaveLength(3);

    await settle(2, artifact(A, 'Alpha', 3));
    expect(await screen.findByText('Alpha v3')).toBeTruthy();
    await settle(1, artifact(A, 'Alpha', 2));
    await flush();
    expect(screen.getByText('Alpha v3')).toBeTruthy();
  });

  it('does not commit an invalidation read after the hook unmounts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = render(<Ref id={A} />);
      await settle(0, artifact(A, 'Alpha', 1));
      expect(await screen.findByText('Alpha v1')).toBeTruthy();
      act(() => invalidateArtifact(A));
      await flush();
      expect(h.pending).toHaveLength(2);
      unmount();
      await settle(1, artifact(A, 'Alpha', 2));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps the newer name when an older lookup resolves last', async () => {
    render(<Names ids={[A]} />);
    await settle(0, artifact(A, 'Alpha', 1));
    expect(await screen.findByText('Alpha')).toBeTruthy();

    act(() => invalidateArtifact(A));
    await flush();
    act(() => invalidateArtifact(A));
    await flush();
    expect(h.pending).toHaveLength(3);

    await settle(2, artifact(A, 'Newest', 3));
    expect(await screen.findByText('Newest')).toBeTruthy();
    await settle(1, artifact(A, 'Older', 2));
    await flush();
    expect(screen.getByText('Newest')).toBeTruthy();
    expect(screen.queryByText('Older')).toBeNull();
  });
});
