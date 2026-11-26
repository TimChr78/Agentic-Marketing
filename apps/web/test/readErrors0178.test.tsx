import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPickerIndexes } from '../src/features/artifacts/pickerIndex';

// #1257: a failed consent.summary read made every purpose say "No recorded choices".
// #1258: a failed read on Hosted pages and Alerts rendered the empty state instead of an error
// with Retry.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({ can: () => true, user: { id: 'usr_1' }, workspace: { id: 'ws_1' } });
  return { useSession: session, useWorkspace: session };
});

vi.mock('../src/features/brand/HostedPreview', () => ({ HostedPreview: () => <div>Hosted preview</div> }));

import { ConsentLedger } from '../src/pages/audience/ConsentPage';
import HostedPagesPage from '../src/pages/design/HostedPagesPage';
import AlertsPage from '../src/pages/insights/AlertsPage';
import { ToastProvider } from '../src/ui';

const purpose = (key: string, name: string) => ({
  key,
  name,
  basis: 'consent',
  channels: ['email'],
  description: '',
  requiresDoubleOptIn: false,
  topics: [],
});

beforeEach(() => {
  h.impl = null;
  resetPickerIndexes();
  localStorage.clear();
});

afterEach(cleanup);

describe('Consent page summary error (#1257)', () => {
  it('shows the failed read with Retry instead of claiming no choices were recorded', async () => {
    h.impl = async (name) => {
      if (name === 'purposes.list')
        return { source: 'published', purposes: [purpose('marketing_email', 'Marketing e-mail'), purpose('analytics', 'Analytics')] };
      if (name === 'consent.summary') throw new Error('the summary read failed');
      throw new Error(`unexpected ${name}`);
    };

    render(<ConsentLedger />);
    await screen.findAllByText('Marketing e-mail');

    expect(await screen.findByText(/Couldn't load consent counts/)).toBeTruthy();
    expect(screen.getByText('the summary read failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText('No recorded choices')).toBeNull();
  });
});

describe('Hosted pages archive error (#1258)', () => {
  it('shows the failed read with Retry instead of the “no public archive yet” empty state', async () => {
    h.impl = async (name, input) => {
      if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null, complete: true };
      if (name === 'archive.issues') throw new Error('the archive read failed');
      throw new Error(`unexpected ${name} for ${JSON.stringify(input)}`);
    };

    render(<HostedPagesPage />);
    await screen.findByText('Hosted preview');

    expect(await screen.findByText(/Couldn't load the newsletter archive/)).toBeTruthy();
    expect(screen.getByText('the archive read failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(/No public archive yet/)).toBeNull();
  });
});

describe('Alerts form reads (#1258)', () => {
  it('shows both failed reads with Retry instead of “no webhooks” and “only admins”', async () => {
    h.impl = async (name) => {
      if (name === 'alerts.list') return { rules: [], publication: { outstanding: 0, failed: 0, oldestPendingAgeMs: null } };
      if (name === 'alerts.history') return { events: [] };
      if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null, complete: true };
      if (name === 'webhooks.list' || name === 'members.list') throw new Error(`${name} read failed`);
      throw new Error(`unexpected ${name}`);
    };

    render(
      <ToastProvider>
        <AlertsPage />
      </ToastProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /new alert/i }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Couldn't load webhook endpoints/)).toBeTruthy();
    expect(within(dialog).getByText(/Couldn't load workspace members/)).toBeTruthy();
    expect(within(dialog).getAllByText(/read failed/)).toHaveLength(2);
    expect(within(dialog).getAllByRole('button', { name: /retry/i })).toHaveLength(2);
    expect(within(dialog).queryByText(/No webhook endpoints yet/)).toBeNull();
    expect(within(dialog).queryByText(/Only workspace admins can pick members here/)).toBeNull();
  });
});
