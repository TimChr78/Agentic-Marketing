import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';

// #1253: the Enter that confirms an IME composition reaches keydown as `key: 'Enter'`. Chrome and
// Firefox mark it `isComposing: true` / `keyCode: 229`; Safari may deliver `compositionend` first,
// leaving `isComposing` false, but `keyCode` is still 229. All three Enter handlers must ignore it.

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null };
        if (name === 'copilot.conversations') return { conversations: [] };
        if (name === 'agents.list') return { agents: [] };
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
    streamFetch: vi.fn(
      async () =>
        new Response(
          `${JSON.stringify({ type: 'done', conversationId: `cop_${'b'.repeat(32)}`, usage: { inputTokens: 1, outputTokens: 1 } })}\n`,
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
    ),
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_1' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_1' } }),
}));

vi.mock('../src/app/capabilities', () => ({
  useCapabilities: () => ({ mutations: true, copilot: true, reason: null }),
  useCopilotAvailable: () => ({ available: true, reason: null }),
}));

import { streamFetch } from '../src/app/api';
import { SearchPalette } from '../src/app/SearchPalette';
import { FormEditor } from '../src/features/artifacts/FormEditor';
import { CopilotDrawer } from '../src/features/copilot/CopilotDrawer';

if (!window.matchMedia)
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

afterEach(() => {
  cleanup();
  vi.mocked(streamFetch).mockClear();
  history.replaceState(null, '', '/');
});

beforeEach(() => {
  setWorkspaceId('11111111-1111-4111-8111-111111111111', { persist: false });
  Element.prototype.scrollIntoView = vi.fn();
});

/** The keydown a browser delivers for the Enter that confirms a composition (Chrome). */
const confirmComposition = (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });

describe('the Enter that confirms an IME composition (#1253)', () => {
  it('does not send the half-composed text to the Copilot', async () => {
    render(<CopilotDrawer open onClose={() => {}} />);
    const box = screen.getByRole('textbox', { name: 'Message to the copilot' });

    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'かってに' } });
    confirmComposition(box);
    fireEvent.compositionEnd(box, { data: '勝手に' });
    expect(streamFetch).not.toHaveBeenCalled();

    // A real Enter afterwards still sends the confirmed text.
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(streamFetch).toHaveBeenCalledTimes(1));
  });

  it('does not open a command palette result', () => {
    const pushState = vi.spyOn(history, 'pushState');
    render(<SearchPalette onClose={() => {}} />);
    const box = screen.getByRole('combobox', { name: 'Search or create' });

    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'new' } });
    confirmComposition(box);
    fireEvent.compositionEnd(box, { data: 'new' });
    expect(pushState).not.toHaveBeenCalled();

    // The same key outside a composition still opens the highlighted result.
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
    expect(pushState).toHaveBeenCalledWith(null, '', '/marketing/broadcasts?create=broadcast');
  });

  it('does not add the unconfirmed form trait', () => {
    const onChange = vi.fn();
    render(
      <FormEditor
        artifact={
          {
            id: `frm_${'a'.repeat(32)}`,
            type: 'form',
            name: 'Signup form',
            latestVersion: 1,
          } as never
        }
        content={{ traits: [] }}
        onChange={onChange}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    const input = screen.getByPlaceholderText('firstName');

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'nickname' } });
    confirmComposition(input);
    fireEvent.compositionEnd(input, { data: 'nickname' });
    expect(onChange).not.toHaveBeenCalled();

    // A real Enter adds the confirmed trait.
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ traits: ['nickname'] }));
  });
});
