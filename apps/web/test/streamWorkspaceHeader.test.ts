import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId, streamFetch } from '../src/app/api';

// #1164: the Copilot stream is a raw fetch, not a typed command, so it used to miss the workspace
// header the rest of the UI sends. The server then fell back to the oldest workspace, and a chat in
// brand B wrote drafts, spent budget and saved history in brand A.

const headerOf = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers);

afterEach(() => {
  vi.unstubAllGlobals();
  setWorkspaceId(null, { persist: false });
});

describe('streamFetch sends the chosen workspace (#1164)', () => {
  it('carries x-workspace-id on a streamed Copilot request', async () => {
    setWorkspaceId('ws_brand_b', { persist: false });
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await streamFetch('/api/copilot', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });

    const headers = headerOf(fetchMock.mock.calls[0] as unknown[]);
    expect(headers.get('x-workspace-id')).toBe('ws_brand_b');
    // The caller's own headers and request options survive.
    expect(headers.get('content-type')).toBe('application/json');
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('sends no workspace header before a workspace is chosen', async () => {
    setWorkspaceId(null, { persist: false });
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await streamFetch('/api/copilot', { method: 'POST' });

    expect(headerOf(fetchMock.mock.calls[0] as unknown[]).get('x-workspace-id')).toBeNull();
  });
});
