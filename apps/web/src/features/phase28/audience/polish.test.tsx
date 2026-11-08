import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../../../app/api';
import ConsentPage from '../../../pages/audience/ConsentPage';
import ImportsPage from '../../../pages/audience/ImportsPage';
import PeoplePage from '../../../pages/audience/PeoplePage';
import { ToastProvider } from '../../../ui';
import { SegmentEditor } from '../../artifacts/SegmentEditor';

// Phase 28 · audience and consent polish (#558). A1: purpose keys never appear as ordinary labels or
// in toasts; names come from the purposes read the screen already performs. A2 and the reserved
// loading slots are exercised as rendered structure; the 390 px layout is checked in e2e.

const ws = '11111111-1111-4111-8111-111111111111';
const profileId = `prf_${'c'.repeat(32)}`;
const segmentId = `seg_${'a'.repeat(32)}`;

type Call = { name: string; input: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  can: (_permission: string): boolean => true,
  hold: new Set<string>(),
  allowed: true,
}));

const purposes = [
  {
    key: 'necessary',
    name: 'Strictly necessary',
    description: 'Running the site and service you asked for.',
    basis: 'contract',
    channels: ['web'],
    requiresDoubleOptIn: false,
    topics: [],
  },
  {
    key: 'web_personalization',
    name: 'Personalization',
    description: 'Tailoring the site to you.',
    basis: 'consent',
    channels: ['web'],
    requiresDoubleOptIn: false,
    topics: [],
  },
  {
    key: 'marketing_email',
    name: 'Marketing e-mail',
    description: 'News and offers by e-mail.',
    basis: 'consent',
    channels: ['email'],
    requiresDoubleOptIn: true,
    topics: [{ key: 'weekly', name: 'Weekly stories', description: '', default: 'subscribed' }],
  },
];

const summary = {
  purposes: [
    {
      purpose: 'necessary',
      granted: 0,
      denied: 0,
      withdrawn: 0,
      objected: 0,
      channels: [{ channel: 'web', granted: 0, denied: 0, withdrawn: 0, objected: 0 }],
    },
    {
      purpose: 'web_personalization',
      granted: 12,
      denied: 1,
      withdrawn: 0,
      objected: 0,
      channels: [{ channel: 'web', granted: 12, denied: 1, withdrawn: 0, objected: 0 }],
    },
    {
      purpose: 'marketing_email',
      granted: 240,
      denied: 2,
      withdrawn: 1,
      objected: 1,
      channels: [{ channel: 'email', granted: 230, denied: 2, withdrawn: 1, objected: 0 }],
    },
  ],
  topics: [{ purpose: 'marketing_email', topic: 'weekly', subscribed: 120, unsubscribed: 4 }],
};

const records = [
  {
    purpose: 'web_personalization',
    channel: 'web',
    status: 'granted',
    basis: 'consent',
    source: 'form',
    proof: { note: 'Site banner v3' },
    recordedAt: '2026-11-02T09:00:00.000Z',
    recordedBy: 'u1',
  },
  {
    purpose: 'marketing_email',
    channel: 'email',
    status: 'granted',
    basis: 'consent',
    source: 'form',
    proof: { note: 'Newsletter checkbox v3' },
    recordedAt: '2026-11-02T09:05:00.000Z',
    recordedBy: 'u1',
  },
];

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        h.calls.push({ name, input });
        if (h.hold.has(name)) await new Promise(() => {});
        if (name === 'purposes.list') return { source: 'published', purposes };
        if (name === 'consent.summary') return summary;
        if (name === 'consent.history') return { records };
        if (name === 'consent.record') return { recorded: true, allowed: h.allowed };
        if (name === 'profiles.find') return { profileId };
        if (name === 'profiles.get')
          return {
            id: profileId,
            personal: { email: 'ada@example.com', firstName: 'Ada' },
            traits: {},
            identifiers: [],
            consent: [],
            mergedFrom: [],
            firstSeen: '2026-10-01T09:00:00.000Z',
            lastSeen: '2026-11-02T09:00:00.000Z',
          };
        if (name === 'profiles.list')
          return {
            profiles: [
              {
                id: profileId,
                email: 'ada@example.com',
                traits: { firstName: 'Ada' },
                consent: [{ purpose: 'marketing_email', status: 'granted' }],
                lastSeen: '2026-11-02T09:00:00.000Z',
              },
            ],
            nextCursor: null,
          };
        if (name === 'profiles.import') return { accepted: 1, rejected: [] };
        if (name === 'segments.preview') return { count: 42 };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => {
  const session = () => ({
    can: (permission: string) => h.can(permission),
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  });
  return { useSession: session, useWorkspace: session };
});

beforeEach(() => {
  cleanup();
  h.calls.length = 0;
  h.can = () => true;
  h.hold.clear();
  h.allowed = true;
  setWorkspaceId(ws, { persist: false });
  window.history.replaceState(null, '', '/');
});

afterEach(() => cleanup());

function renderWithToast(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

function keysInText(text: string | null | undefined): boolean {
  return /web_personalization|marketing_email|\bnecessary\b/.test(text ?? '');
}

describe('consent purpose labels (A1)', () => {
  it('shows purpose names in the consent table and never the technical keys', async () => {
    renderWithToast(<ConsentPage />);
    const table = await screen.findByRole('table', { name: 'Purposes' });
    expect(within(table).getByText('Personalization')).toBeTruthy();
    expect(within(table).getByText('Strictly necessary')).toBeTruthy();
    expect(within(table).getByText('Marketing e-mail')).toBeTruthy();
    expect(within(table).queryByText('web_personalization')).toBeNull();
    expect(within(table).queryByText('marketing_email')).toBeNull();
    expect(within(table).queryByText('necessary')).toBeNull();
    expect(keysInText(table.textContent)).toBe(false);
  });

  it('lists purpose names in the record drawer and names the recorded purpose in the toast', async () => {
    renderWithToast(<ConsentPage />);
    await screen.findByRole('table', { name: 'Purposes' });
    fireEvent.change(screen.getByLabelText('E-mail or profile id'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await screen.findByRole('table', { name: 'Consent ledger' });

    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    const drawer = screen.getByRole('dialog', { name: 'Record consent' });
    const purpose = within(drawer).getByLabelText(/^Purpose/) as HTMLSelectElement;
    expect(within(purpose).getByRole('option', { name: 'Marketing e-mail' })).toBeTruthy();
    expect(within(purpose).queryByRole('option', { name: /marketing_email/ })).toBeNull();
    expect(within(purpose).queryByRole('option', { name: /web_personalization/ })).toBeNull();

    fireEvent.change(purpose, { target: { value: 'marketing_email' } });
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Record consent' }).at(-1)!);
    expect(await screen.findByText(/Recorded “Marketing e-mail” as Granted/)).toBeTruthy();
    expect(screen.queryByText(/Recorded “marketing_email”/)).toBeNull();
  });

  it('shows the friendly purpose in the append-only ledger, not the key', async () => {
    renderWithToast(<ConsentPage />);
    await screen.findByRole('table', { name: 'Purposes' });
    fireEvent.change(screen.getByLabelText('E-mail or profile id'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    const ledger = await screen.findByRole('table', { name: 'Consent ledger' });
    expect(within(ledger).getByText('Personalization')).toBeTruthy();
    expect(within(ledger).getByText('Marketing e-mail')).toBeTruthy();
    expect(within(ledger).queryByText(/web_personalization/)).toBeNull();
    expect(keysInText(ledger.textContent)).toBe(false);
  });
});

describe('import purpose labels (A1)', () => {
  it('offers names and previews the selected name, without the technical key', async () => {
    renderWithToast(<ImportsPage />);
    fireEvent.change(screen.getByLabelText('Or paste the CSV'), {
      target: { value: 'email_address,first_name\nada@example.com,Ada' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use pasted CSV' }));
    await waitFor(() => expect((screen.getByLabelText(/^Purpose/) as HTMLElement).tagName).toBe('SELECT'));
    const purpose = screen.getByLabelText(/^Purpose/) as HTMLSelectElement;
    expect(within(purpose).getByRole('option', { name: 'Marketing e-mail' })).toBeTruthy();
    expect(within(purpose).queryByRole('option', { name: /\(marketing_email\)/ })).toBeNull();
    fireEvent.change(purpose, { target: { value: 'marketing_email' } });

    const preview = await screen.findByRole('table', { name: 'Rows to import' });
    expect(within(preview).getByText(/Granted · Marketing e-mail/)).toBeTruthy();
    expect(within(preview).queryByText(/marketing_email/)).toBeNull();
  });
});

describe('segment consent condition labels (A1)', () => {
  function renderSegment(consent: string) {
    const content = { mode: 'dynamic', condition: { consent } };
    return renderWithToast(
      <SegmentEditor
        artifact={{ id: segmentId, type: 'segment', name: 'Readers' } as never}
        content={content as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
  }

  it('uses the purpose name in the condition selector', async () => {
    renderSegment('web_personalization');
    const select = (await screen.findByLabelText('Purpose, condition 1')) as HTMLSelectElement;
    expect(await within(select).findByRole('option', { name: 'Personalization' })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: /web_personalization/ })).toBeNull();
  });

  it('names an unknown purpose and keeps its key behind the copy control', async () => {
    renderSegment('legacy_purpose');
    const select = (await screen.findByLabelText('Purpose, condition 1')) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: 'Unavailable purpose' })).toBeTruthy();
    expect(within(select).queryByText(/legacy_purpose/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy purpose key legacy_purpose' })).toBeTruthy();
  });
});

describe('reserved loading slots (A)', () => {
  it('reserves the People list with the shared list skeleton', async () => {
    h.hold.add('profiles.list');
    renderWithToast(<PeoplePage />);
    const region = await screen.findByRole('status', { name: 'Loading people' });
    expect(region.getAttribute('data-geometry')).toBe('list');
    expect(region.getAttribute('aria-busy')).toBe('true');
  });

  it('reserves the consent purposes table with its five columns', async () => {
    h.hold.add('purposes.list');
    renderWithToast(<ConsentPage />);
    const region = await screen.findByRole('status', { name: 'Loading purposes' });
    expect(region.getAttribute('data-geometry')).toBe('list');
    expect(region.querySelectorAll('[data-skeleton-list="table"] [data-skeleton-shape]').length).toBeGreaterThan(5);
  });
});
