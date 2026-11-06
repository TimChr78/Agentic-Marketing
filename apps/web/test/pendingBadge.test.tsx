import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #483: the nav badge counts decisions. Two rows of one bundle are one pending decision, exactly
// as the Approvals page groups them.

const h = vi.hoisted(() => ({ approvals: [] as unknown[], total: 2 }));

vi.mock('../src/app/theme', () => ({ setThemeUser: vi.fn() }));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'workspace.get') return { id: 'ws_1', timeZone: 'UTC', you: { permissions: [] } };
        if (name === 'workspace.memberships') return { workspaces: [] };
        if (name === 'approvals.list') return { approvals: h.approvals, total: h.total, nextCursor: null };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

import { SessionProvider, useSession } from '../src/app/session';
import { pendingDecisionCount } from '../src/features/approvals/decisions';

function Pending() {
  const { pending } = useSession();
  return <span data-testid="pending">{pending}</span>;
}

function pendingRow(id: string) {
  return {
    id,
    artifactId: `bct_${'a'.repeat(32)}`,
    artifactName: `Change ${id}`,
    artifactType: 'broadcast',
    version: 1,
    status: 'pending',
    requestedAt: '2026-11-06T09:00:00.000Z',
    requestedBy: null,
    holdUntil: null,
  };
}

beforeEach(() => {
  const member = pendingRow('apr_member');
  const lead = pendingRow('apr_lead');
  const bundle = {
    id: 'bnd_1',
    members: [
      { approvalId: member.id, artifactId: 'bct_1' },
      { approvalId: lead.id, artifactId: 'bct_2' },
    ],
  };
  h.approvals = [
    { ...member, bundle },
    { ...lead, bundle },
  ];
  h.total = 2;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ user: { id: 'p1', name: 'A', email: 'a@example.com' } }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('pending approvals badge (#483)', () => {
  it('counts a two-member bundle as one decision, not two rows', async () => {
    expect(pendingDecisionCount(h.approvals as never)).toBe(1);
    render(
      <SessionProvider>
        <Pending />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe('1'));
  });
});
