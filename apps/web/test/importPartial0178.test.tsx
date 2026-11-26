import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1250 review: when a later batch fails, the people already imported must stay visible instead of
// the whole import turning into one error.

const h = vi.hoisted(() => ({
  imports: [] as { label: string; rows: unknown[] }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: { label?: string; rows?: unknown[] }) => {
        if (name === 'purposes.list')
          return {
            source: 'published',
            purposes: [{ key: 'marketing_email', name: 'Marketing e-mail', basis: 'consent', channels: ['email'], topics: [] }],
          };
        if (name === 'profiles.import') {
          h.imports.push({ label: input.label ?? '', rows: input.rows ?? [] });
          if (h.imports.length === 2) throw new Error('the second batch failed');
          return { batchId: 'imp_1', accepted: 1, rejected: [] };
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({ can: () => true, user: { id: 'usr_1' }, workspace: { id: 'ws_1' } });
  return { useSession: session, useWorkspace: session };
});

// Keep parsing and mapping real; only the batch split is deterministic in this test.
vi.mock('../src/lib/csvImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/csvImport')>();
  return {
    ...actual,
    batchImportRows: <T,>(rows: readonly T[]) => {
      const [first, ...rest] = rows;
      return first === undefined ? [] : [[first], rest];
    },
  };
});

import ImportsPage from '../src/pages/audience/ImportsPage';
import { ToastProvider } from '../src/ui';

afterEach(() => {
  cleanup();
  h.imports.length = 0;
});

describe('Imports partial result (#1250 review)', () => {
  it('keeps the people imported by earlier batches when a later batch fails', async () => {
    render(
      <ToastProvider>
        <ImportsPage />
      </ToastProvider>,
    );

    const csv = [
      'email_address,first_name,state,created_at',
      'ada@example.com,Ada,active,2026-01-01',
      'grace@example.com,Grace,active,2026-01-01',
    ].join('\n');
    await userEvent.type(screen.getByPlaceholderText('email_address,first_name,state,created_at'), csv);
    await userEvent.click(screen.getByRole('button', { name: /use pasted csv/i }));
    await userEvent.click(await screen.findByRole('button', { name: /import 2 people/i }));

    await waitFor(() => expect(h.imports).toHaveLength(2));
    expect(await screen.findByText(/Imported 1 person/)).toBeTruthy();
    expect(screen.getByText(/The import stopped after 1 person: the second batch failed/)).toBeTruthy();
  });
});
