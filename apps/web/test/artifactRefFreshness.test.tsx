import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateArtifact, useArtifactNames } from '../src/features/artifactCache';
import { RefName } from '../src/features/previews/FormPreview';

// #770: the reference pills ("Live v3") read through the session cache but subscribed to nothing,
// so an in-tab publish left the mounted preview on the old pointer until a remount.

const h = vi.hoisted(() => ({
  artifacts: {} as Record<string, unknown>,
  reads: [] as string[],
}));

const tpl = `eml_${'b'.repeat(32)}`;
const form = `frm_${'a'.repeat(32)}`;

const artifact = (id: string, name: string, publishedVersion: number | null) => ({
  id,
  type: id.startsWith('frm_') ? 'form' : 'email_template',
  name,
  latestVersion: publishedVersion ?? 1,
  publishedVersion,
  layout: null,
  references: [],
  version: {
    number: publishedVersion ?? 1,
    state: publishedVersion === null ? 'draft' : 'published',
    content: { description: '', mode: 'dynamic', condition: {} },
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
        if (name !== 'artifacts.get') throw new Error(`unexpected command ${name}`);
        const id = String(input.artifactId ?? '');
        h.reads.push(id);
        const found = h.artifacts[id];
        if (!found) throw new Error('This item does not exist.');
        return found;
      }),
    },
  };
});

beforeEach(() => {
  cleanup();
  h.reads.length = 0;
  h.artifacts = {
    [form]: artifact(form, 'Signup form', 2),
    [tpl]: artifact(tpl, 'Confirmation', 1),
  };
  invalidateArtifact(form);
  invalidateArtifact(tpl);
});

afterEach(cleanup);

describe('artifact reference pills follow an in-tab publish (#770)', () => {
  it('updates a mounted RefName when its artifact is published again', async () => {
    render(<RefName id={form} />);
    expect(await screen.findByText('Live v2')).toBeTruthy();

    // The publish dialog commits v3 in this tab and drops the cache entry.
    h.artifacts[form] = artifact(form, 'Signup form', 3);
    act(() => invalidateArtifact(form));

    await waitFor(() => expect(screen.getByText('Live v3')).toBeTruthy());
    expect(screen.queryByText('Live v2')).toBeNull();
  });

  it('renames a mounted reference when only the name changed', async () => {
    render(<RefName id={form} />);
    expect(await screen.findByText('Signup form')).toBeTruthy();

    h.artifacts[form] = artifact(form, 'Newsletter signup', 2);
    act(() => invalidateArtifact(form));

    await waitFor(() => expect(screen.getByText('Newsletter signup')).toBeTruthy());
    expect(screen.queryByText('Signup form')).toBeNull();
  });

  it('does not re-read an unrelated reference', async () => {
    render(<RefName id={form} />);
    expect(await screen.findByText('Live v2')).toBeTruthy();
    const before = h.reads.filter((id) => id === form).length;

    act(() => invalidateArtifact(tpl));
    await act(async () => {});

    expect(h.reads.filter((id) => id === form)).toHaveLength(before);
  });
});

function Names({ ids }: { ids: string[] }) {
  const name = useArtifactNames(ids);
  return <p>{ids.map((id) => name(id) ?? '…').join(', ')}</p>;
}

describe('the shared name lookup follows an in-tab change (#770)', () => {
  it('shows the new name after a rename', async () => {
    render(<Names ids={[tpl]} />);
    expect(await screen.findByText('Confirmation')).toBeTruthy();

    h.artifacts[tpl] = artifact(tpl, 'Order confirmation', 2);
    act(() => invalidateArtifact(tpl));

    await waitFor(() => expect(screen.getByText('Order confirmation')).toBeTruthy());
  });
});
