import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardianCard } from '../src/features/agents/GuardianCard';
import { ToastProvider } from '../src/ui/toast';

// #1168: an unguarded agent with no episodes used to render nothing at all, hiding a failed
// `agents.guardian` read and its Retry action. The card stays hidden only for a successful empty
// read; a loading or failed read must still show the request's state.

const h = vi.hoisted(() => ({
  error: new Error('The guardian history is unavailable.'),
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'agents.guardian') throw h.error;
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({ can: () => true, workspace: { id: 'ws_1' }, user: { id: 'u1' } }),
}));

afterEach(cleanup);

describe('guardian card (#1168)', () => {
  it('shows a failed history read for an unguarded agent, with Retry', async () => {
    render(
      <ToastProvider>
        <GuardianCard agent={{ id: 'agt_1', name: 'Newsletter agent', status: 'active', guard: null } as never} onChanged={() => {}} />
      </ToastProvider>,
    );
    expect(await screen.findByText('The guardian history is unavailable.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
