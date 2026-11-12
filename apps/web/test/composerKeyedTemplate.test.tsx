// 0.14.6 review: switching the broadcast template while the new template's exact version loads must
// never report the previous template's purpose as ready.
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  held: new Map<string, (value: unknown) => void>(),
  hold: new Set<string>(),
}));

const A = `eml_${'a'.repeat(32)}`;
const B = `eml_${'b'.repeat(32)}`;
const artifact = (id: string, purpose: string) => ({
  artifact: { id, type: 'email_template', name: id === A ? 'Alpha' : 'Beta', publishedVersion: 1 },
  publishedVersion: 1,
  version: { version: 1, content: { purpose } },
});

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: any) => {
        const key = `${name}:${input?.artifactId ?? ''}:${input?.version ?? ''}`;
        if (h.hold.has(key)) return new Promise((resolve) => h.held.set(key, resolve));
        if (name === 'artifacts.get') return Promise.resolve(artifact(input.artifactId, input.artifactId === A ? 'news' : 'missing'));
        if (name === 'purposes.list')
          return Promise.resolve({
            purposes: [{ key: 'news', name: 'Newsletter', basis: 'consent', channels: ['email'], topics: [], requiresDoubleOptIn: false }],
          });
        if (name === 'system.status') return Promise.resolve({ emailProvider: { marketing: true, transactional: true } });
        if (name === 'sendingDomains.list') return Promise.resolve({ domains: [], checkedAt: null });
        return Promise.reject(new Error(`unexpected ${name}`));
      }),
    },
  };
});

import { useComposerData } from '../src/features/broadcasts/composer/useComposerData';

const consent = (rows: { key: string; status: string }[]) => rows.find((r) => r.key === 'consent')?.status;

describe('useComposerData keyed by template (0.14.6 review)', () => {
  beforeEach(() => {
    h.held.clear();
    h.hold.clear();
  });

  it("does not report the previous template's purpose as ready while the new one loads", async () => {
    const { result, rerender } = renderHook(
      ({ templateId }) => useComposerData({ templateId, broadcastTopic: undefined, canRead: true, canAdmin: false, refreshKey: 0 }),
      { initialProps: { templateId: A } },
    );
    await waitFor(() => expect(consent(result.current.rows)).toBe('ready'));

    h.hold.add(`artifacts.get:${B}:1`);
    h.hold.add(`artifacts.get:${B}:`);
    rerender({ templateId: B });
    // While B (or its exact version) is pending, nothing of A may be judged ready.
    expect(consent(result.current.rows)).not.toBe('ready');
    expect(result.current.templateContent).toBeUndefined();
    await waitFor(() => expect(h.held.size).toBeGreaterThan(0));
    expect(consent(result.current.rows)).not.toBe('ready');
    expect(result.current.templateContent).toBeUndefined();

    // Phase 2: B's metadata arrives while its exact version is still held. A's content must stay
    // withheld, and the consent row must not be ready.
    h.held.get(`artifacts.get:${B}:`)?.(artifact(B, 'missing'));
    await waitFor(() => expect(h.held.has(`artifacts.get:${B}:1`)).toBe(true));
    expect(result.current.templateContent).toBeUndefined();
    expect(consent(result.current.rows)).not.toBe('ready');

    // Phase 3: B's exact version arrives; B's own purpose (not configured) is what the row judges.
    h.held.get(`artifacts.get:${B}:1`)?.(artifact(B, 'missing'));
    await waitFor(() => expect(result.current.templateContent).toEqual({ purpose: 'missing' }));
    expect(consent(result.current.rows)).toBe('attention');
  });
});
