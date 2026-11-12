import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Deferred, deferred, settle } from './keyedReadsSupport';

// #617: a second consent lookup must never show the first person's identity or ledger under the
// new search, and "Record consent" must not be offered while the new profile is still loading.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_consent' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_consent' }, workspace: { id: 'ws_1' } }),
}));

import { ConsentLedger } from '../src/pages/audience/ConsentPage';
import { ToastProvider } from '../src/ui/toast';

const ADA = `prf_${'a'.repeat(32)}`;
const BOB = `prf_${'b'.repeat(32)}`;

const person = (id: string, email: string) => ({
  id,
  traits: {},
  personal: { email },
  identifiers: [{ type: 'email', value: email, firstSeen: '2026-11-01T09:00:00.000Z', lastSeen: '2026-11-01T09:00:00.000Z' }],
  consent: [],
  mergedFrom: [],
  firstSeen: '2026-11-01T09:00:00.000Z',
  lastSeen: '2026-11-01T09:00:00.000Z',
});

const record = (proof: string) => ({
  purpose: 'marketing_email',
  channel: 'email',
  status: 'granted',
  basis: 'consent',
  source: 'form',
  proof: { messageId: proof },
  proofWithheld: false,
  recordedAt: '2026-11-05T09:00:00.000Z',
  recordedBy: null,
});

const purposes = {
  source: 'published',
  purposes: [
    {
      key: 'marketing_email',
      name: 'Marketing e-mail',
      description: '',
      basis: 'consent',
      channels: ['email'],
      requiresDoubleOptIn: false,
      topics: [],
    },
  ],
};

let bobProfile: Deferred<unknown>;
let bobHistory: Deferred<unknown>;

beforeEach(() => {
  h.calls.length = 0;
  bobProfile = deferred();
  bobHistory = deferred();
  h.impl = (name, input) => {
    if (name === 'purposes.list') return Promise.resolve(purposes);
    if (name === 'consent.summary') return Promise.resolve({ purposes: [], topics: [] });
    if (name === 'profiles.find') return Promise.resolve({ profileId: input.value === 'bob@example.com' ? BOB : ADA });
    if (name === 'profiles.get') {
      if (input.profileId === BOB) return bobProfile.promise;
      return Promise.resolve(person(ADA, 'ada@example.com'));
    }
    if (name === 'consent.history') {
      if (input.profileId === BOB) return bobHistory.promise;
      return Promise.resolve({ records: [record('proof-ada-only')] });
    }
    throw new Error(`unexpected command ${name}`);
  };
});

afterEach(cleanup);

describe('consent lookup switched to a keyed read (#617)', () => {
  it('withholds the first person and their ledger while the second person loads', async () => {
    render(
      <ToastProvider>
        <ConsentLedger />
      </ToastProvider>,
    );

    const field = screen.getByLabelText('E-mail or profile id');
    fireEvent.change(field, { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up/ }));

    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(await screen.findByText(/proof-ada-only/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Record consent/ })).toBeTruthy();

    fireEvent.change(field, { target: { value: 'bob@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up/ }));
    await waitFor(() => expect(screen.getByText(/Found from bob@example.com/)).toBeTruthy());

    // Bob's reads are still pending: Ada's identity and proof must be gone, with a skeleton shown.
    expect(screen.queryByText('ada@example.com')).toBeNull();
    expect(screen.queryByText(/proof-ada-only/)).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading person' })).toBeTruthy();
    // The ledger action must not be offered while the visible person is not the loaded one.
    expect(screen.queryByRole('button', { name: /Record consent/ })).toBeNull();

    await settle(bobProfile, person(BOB, 'bob@example.com'));
    await settle(bobHistory, { records: [record('proof-bob-only')] });

    expect(await screen.findByText('bob@example.com')).toBeTruthy();
    expect(await screen.findByText(/proof-bob-only/)).toBeTruthy();
    expect(screen.queryByText(/proof-ada-only/)).toBeNull();
    expect(screen.getByRole('button', { name: /Record consent/ })).toBeTruthy();
  });
});
