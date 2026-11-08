import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../app/api';
import PeoplePage from '../../../pages/audience/PeoplePage';
import PersonPage from '../../../pages/audience/PersonPage';
import { ToastProvider } from '../../../ui/toast';
import { consentLabel, purposeAllowed } from './model';
import { resetPurposesCache } from './usePurposes';

type Call = { name: string; input: any };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  can: (_permission: string): boolean => true,
  respond: (_name: string, _input: any): unknown => {
    throw new Error('no mock response');
  },
  hold: new Set<string>(),
  held: [] as { name: string; resolve: (value: unknown) => void }[],
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: any) => {
        h.calls.push({ name, input });
        if (h.hold.has(name)) {
          return new Promise((resolve) => h.held.push({ name, resolve }));
        }
        return h.respond(name, input);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: (p: string) => h.can(p), workspace: { id: 'ws_1' }, user: { id: 'u1' } }),
  useWorkspace: () => ({ can: (p: string) => h.can(p), workspace: { id: 'ws_1' }, user: { id: 'u1' } }),
}));

const personId = `prf_${'a'.repeat(32)}`;
const canonicalId = `prf_${'b'.repeat(32)}`;
const otherId = `prf_${'c'.repeat(32)}`;

const purpose = (key: string, name: string, basis = 'consent') => ({
  key,
  name,
  basis,
  channels: ['email'],
  description: '',
  requiresDoubleOptIn: false,
  topics: [],
});

const purposes = {
  source: 'published',
  purposes: [
    purpose('marketing_email', 'Newsletter'),
    purpose('product_updates', 'Product updates'),
    purpose('service_notices', 'Service notices', 'legitimate_interest'),
  ],
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: personId,
  traits: {},
  known: true,
  lastSeen: '2026-11-06T21:42:00.000000Z',
  firstSeen: '2026-09-01T00:00:00.000000Z',
  consent: [
    { purpose: 'marketing_email', status: 'granted' },
    { purpose: 'product_updates', status: null },
    { purpose: 'service_notices', status: null },
  ],
  email: 'ada@example.com',
  ...overrides,
});

const listPage = (overrides: Record<string, unknown> = {}) => ({
  profiles: [row()],
  nextCursor: null,
  ...overrides,
});

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: canonicalId,
  traits: { plan: 'pro' },
  personal: { email: 'ada@example.com', name: 'Ada Rivera' },
  identifiers: [{ type: 'email', value: 'ada@example.com', firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-11-06T21:42:00.000Z' }],
  consent: [
    {
      purpose: 'marketing_email',
      channel: 'email',
      status: 'granted',
      basis: 'consent',
      source: 'form',
      updatedAt: '2026-11-05T09:00:00.000Z',
    },
    {
      purpose: 'product_updates',
      channel: '',
      status: 'withdrawn',
      basis: 'consent',
      source: 'unsubscribe',
      updatedAt: '2026-10-01T09:00:00.000Z',
    },
    {
      purpose: 'service_notices',
      channel: '',
      status: null,
      basis: 'legitimate_interest',
      source: 'default',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  mergedFrom: [],
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: '2026-11-06T21:42:00.000Z',
  ...overrides,
});

const events = (overrides: Record<string, unknown> = {}) => ({
  events: [
    {
      eventId: 'evt_1',
      type: 'track',
      name: 'Signed in',
      timestamp: '2026-11-06T21:42:00.000Z',
      properties: {},
      context: {},
    },
    {
      eventId: 'evt_2',
      type: 'track',
      name: 'Viewed page',
      timestamp: '2026-11-04T08:00:00.000Z',
      properties: {},
      context: {},
    },
  ],
  nextCursor: { timestamp: '2026-11-06T21:42:00.000000Z', eventId: 'evt_1' },
  ...overrides,
});

const message = (overrides: Record<string, unknown> = {}) => ({
  id: `msg_${'d'.repeat(32)}`,
  channel: 'email',
  profileId: canonicalId,
  templateId: `eml_${'e'.repeat(32)}`,
  templateVersion: 1,
  purpose: 'marketing_email',
  status: 'delivered',
  reason: null,
  attempts: 1,
  nextAttemptAt: null,
  lastError: null,
  notBefore: null,
  segments: null,
  test: false,
  createdAt: '2026-11-06T16:00:00.000Z',
  events: [
    {
      type: 'delivered',
      at: '2026-11-06T16:10:00.000Z',
      reason: '',
      url: 'https://private.example/track?token=secret',
    },
  ],
  ...overrides,
});

const messages = (overrides: Record<string, unknown> = {}) => ({
  messages: [message()],
  nextCursor: 'm1.eyJhdCI6IjIwMjYtMTEtMDZUMTY6MDA6MDAuMDAwMDAwWiIsImlkIjoibXNnIn0',
  ...overrides,
});

const consentHistory = (overrides: Record<string, unknown> = {}) => ({
  records: [
    {
      purpose: 'marketing_email',
      channel: 'email',
      status: 'granted',
      basis: 'consent',
      source: 'preference_form',
      proof: {},
      recordedAt: '2026-11-05T09:00:00.000Z',
      recordedBy: null,
    },
  ],
  ...overrides,
});

const baseRespond = (name: string, input: any) => {
  if (name === 'profiles.list') return listPage();
  if (name === 'purposes.list') return purposes;
  if (name === 'profiles.get') return profile({ id: input.profileId === personId ? canonicalId : input.profileId });
  if (name === 'profiles.events') return events();
  if (name === 'messages.list') return messages();
  if (name === 'consent.history') return consentHistory();
  if (name === 'profiles.find') return { profileId: personId };
  if (name === 'topics.preferences') return { topics: [] };
  if (name === 'segments.ofProfile') return { segments: [] };
  throw new Error(`unexpected command ${name}`);
};

const renderList = () =>
  render(
    <ToastProvider>
      <PeoplePage />
    </ToastProvider>,
  );
const renderPerson = (id = personId) =>
  render(
    <ToastProvider>
      <PersonPage params={{ id }} />
    </ToastProvider>,
  );
const peopleTable = () => within(screen.getByRole('table', { name: 'People' }));

const names = () => h.calls.map((c) => c.name);
const calls = (name: string) => h.calls.filter((c) => c.name === name);

beforeEach(() => {
  h.calls.length = 0;
  h.held.length = 0;
  h.hold.clear();
  h.can = () => true;
  h.respond = baseRespond;
  resetPurposesCache();
  window.scrollTo = () => {};
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(cleanup);

describe('consent and eligibility (#510)', () => {
  it('mirrors purposeAllowed and never turns a missing record into a refusal', () => {
    expect(purposeAllowed(null, 'granted')).toBeNull();
    expect(purposeAllowed('consent', null)).toBe(false);
    expect(purposeAllowed('consent', 'granted')).toBe(true);
    expect(purposeAllowed('legitimate_interest', null)).toBe(true);
    expect(purposeAllowed('legitimate_interest', 'objected')).toBe(false);
    expect(purposeAllowed('contract', undefined)).toBe(true);
    expect(consentLabel(null)).toBe('No recorded choice');
  });
});

describe('People list (#510)', () => {
  it('reads one page and the purposes once, never a profile per row', async () => {
    renderList();
    await screen.findAllByText('ada@example.com');

    expect(names()).toEqual(['profiles.list', 'purposes.list']);
    expect(calls('profiles.list')[0].input).toEqual({ limit: 50 });
    expect(calls('profiles.list')[0].input).not.toHaveProperty('before');
    expect(calls('profiles.get')).toHaveLength(0);
    // The test hooks the visual suite masks: identity, consent status and last seen per row.
    const volatile = [...document.querySelectorAll('[data-volatile]')];
    expect(volatile.some((element) => element.textContent === 'ada@example.com')).toBe(true);
    expect(volatile.some((element) => element.textContent === 'Allowed')).toBe(true);
    expect(volatile.some((element) => element.getAttribute('title') === row().lastSeen)).toBe(true);
  });

  it('does not read purposes without artifacts:read', async () => {
    h.can = (permission) => permission !== 'artifacts:read';
    renderList();
    expect(within(await screen.findByRole('table', { name: 'People' })).getAllByText('Unavailable purpose')).toHaveLength(3);
    expect(names()).toEqual(['profiles.list']);
  });

  it('shows what is loaded, with an honest page and availability, and pages with the cursor stack', async () => {
    h.respond = (name, input) => {
      if (name === 'profiles.list' && !input.before) {
        return listPage({ nextCursor: { lastSeen: '2026-11-06T21:42:00.000000Z', id: personId } });
      }
      if (name === 'profiles.list') return listPage({ profiles: [row({ id: otherId, email: 'lee@example.com' })], nextCursor: null });
      return baseRespond(name, input);
    };
    renderList();
    expect(await screen.findByText('1 shown · Page 1')).toBeTruthy();
    expect(screen.getByText('More people available')).toBeTruthy();
    expect(screen.queryByText('1 person')).toBeNull();
    expect(screen.queryByText('1 people')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('1 shown · Page 2')).toBeTruthy();
    expect(screen.getByText('End of list')).toBeTruthy();
    // Microseconds survive the cursor unchanged.
    expect(calls('profiles.list').at(-1)?.input).toEqual({
      limit: 50,
      before: '2026-11-06T21:42:00.000000Z',
      beforeId: personId,
    });

    const before = h.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('1 shown · Page 1')).toBeTruthy();
    expect(h.calls.length).toBe(before);
  });

  it('drops a Next response that arrives after a refresh', async () => {
    let resolveNext: ((value: unknown) => void) | null = null;
    const cursor = { lastSeen: '2026-11-06T21:42:00.000000Z', id: personId };
    h.respond = (name, input) => {
      if (name === 'profiles.list' && input.before) {
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      }
      if (name === 'profiles.list') return listPage({ nextCursor: cursor });
      return baseRespond(name, input);
    };
    renderList();
    expect(await screen.findByText('1 shown · Page 1')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(calls('profiles.list').filter((call) => call.input.before)).toHaveLength(1));

    // Refresh while the old page is still in flight: the old response must not join the new stack.
    await userEvent.click(screen.getByRole('button', { name: 'Refresh people' }));
    await waitFor(() => expect(calls('profiles.list').filter((call) => !call.input.before)).toHaveLength(2));
    expect(await screen.findByText('1 shown · Page 1')).toBeTruthy();

    await act(async () => {
      resolveNext?.(listPage({ profiles: [row({ id: otherId, email: 'stale@example.com' })], nextCursor: null }));
    });
    expect(screen.queryAllByText('stale@example.com')).toHaveLength(0);
    expect(screen.getByText('1 shown · Page 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /previous/i }).hasAttribute('disabled')).toBe(true);

    // Next after the refresh reads a fresh page instead of stepping into a stale stack.
    const beforeRefreshStack = calls('profiles.list').length;
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(calls('profiles.list').length).toBe(beforeRefreshStack + 1));
    expect(calls('profiles.list').at(-1)?.input).toEqual({ limit: 50, before: cursor.lastSeen, beforeId: cursor.id });
  });

  it('separates the first empty page from a list that changed underneath', async () => {
    h.respond = (name, input) => {
      if (name === 'profiles.list' && !input.before) {
        return listPage({ profiles: [row()], nextCursor: { lastSeen: '2026-11-06T21:42:00.000000Z', id: personId } });
      }
      if (name === 'profiles.list') return listPage({ profiles: [], nextCursor: null });
      return baseRespond(name, input);
    };
    renderList();
    await screen.findAllByText('ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('List changed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Return to first page' })).toBeTruthy();

    // A first page with nothing at all is its own, honest empty state.
    cleanup();
    h.calls.length = 0;
    h.respond = (name, input) => (name === 'profiles.list' ? listPage({ profiles: [], nextCursor: null }) : baseRespond(name, input));
    renderList();
    expect(await screen.findByText('No people yet')).toBeTruthy();
  });

  it('searches only on submit, by exact e-mail, and opens the match', async () => {
    const push = vi.spyOn(history, 'pushState');
    renderList();
    await screen.findAllByText('ada@example.com');
    const input = screen.getByLabelText('E-mail or profile ID');
    await userEvent.type(input, 'lee@example.com');
    expect(calls('profiles.find')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Find person' }));
    await waitFor(() => expect(calls('profiles.find')).toHaveLength(1));
    expect(calls('profiles.find')[0].input).toEqual({ type: 'email', value: 'lee@example.com' });
    expect(push).toHaveBeenCalledWith(null, '', `/audience/people/${personId}`);
    push.mockRestore();
  });

  it('opens a pasted profile id directly without a lookup', async () => {
    const push = vi.spyOn(history, 'pushState');
    renderList();
    await screen.findAllByText('ada@example.com');
    const id = `prf_${'c'.repeat(32)}`;
    await userEvent.type(screen.getByLabelText('E-mail or profile ID'), id);
    await userEvent.click(screen.getByRole('button', { name: 'Find person' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(null, '', `/audience/people/${id}`));
    expect(calls('profiles.find')).toHaveLength(0);
    push.mockRestore();
  });

  it('explains an unknown e-mail without opening anyone', async () => {
    h.respond = (name, input) => (name === 'profiles.find' ? { profileId: null } : baseRespond(name, input));
    renderList();
    await screen.findAllByText('ada@example.com');
    await userEvent.type(screen.getByLabelText('E-mail or profile ID'), 'nobody@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Find person' }));
    expect(await screen.findByText(/No one has that e-mail/)).toBeTruthy();
  });

  it('displays the e-mail first, the name second, and the id only behind a copy control', async () => {
    h.respond = (name, input) =>
      name === 'profiles.list' ? listPage({ profiles: [row({ traits: { name: 'Ada Rivera' } })] }) : baseRespond(name, input);
    renderList();
    await screen.findAllByText('ada@example.com');
    const table = await screen.findByRole('table', { name: 'People' });
    expect(within(table).getByText('Ada Rivera')).toBeTruthy();
    expect(screen.queryByText(personId)).toBeNull();

    const copy = within(table).getByRole('button', { name: 'Copy person ID' });
    await userEvent.click(copy);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(personId);
    expect(await screen.findByText('Person ID copied')).toBeTruthy();
  });

  it('shows a purpose beside every consent choice, with no aggregate and no invented refusal', async () => {
    renderList();
    await screen.findAllByText('ada@example.com');
    const table = peopleTable();
    expect(table.getByText('Newsletter')).toBeTruthy();
    expect(table.getByText('Allowed')).toBeTruthy();
    expect(table.getByText('Product updates')).toBeTruthy();
    expect(table.getAllByText('No recorded choice').length).toBeGreaterThan(0);
    expect(screen.queryByText(/1 allowed/i)).toBeNull();
    expect(screen.queryByText(/not allowed/i)).toBeNull();
  });

  it('names an unavailable purpose honestly and keeps its key behind a copy control', async () => {
    h.can = (permission) => permission !== 'artifacts:read';
    renderList();
    await screen.findAllByText('ada@example.com');
    const table = peopleTable();
    expect(table.getAllByText('Unavailable purpose')).toHaveLength(3);
    expect(screen.queryByText('marketing_email')).toBeNull();
    expect(table.getByRole('button', { name: 'Copy purpose key marketing_email' })).toBeTruthy();
  });

  it('keeps a failed purpose-name read local and retries only it', async () => {
    let fail = true;
    h.respond = (name, input) => {
      if (name === 'purposes.list' && fail) throw new Error('Purpose names unavailable');
      return baseRespond(name, input);
    };
    renderList();
    await screen.findAllByText('ada@example.com');
    expect(await screen.findByText(/Purpose names could not load/)).toBeTruthy();
    expect(peopleTable().getAllByText('Unavailable purpose')).toHaveLength(3);

    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry purpose names' }));
    expect(await waitFor(() => peopleTable().getByText('Newsletter'))).toBeTruthy();
  });

  it('hides e-mail and name for a role without profiles:pii, and says so', async () => {
    h.can = (permission) => permission !== 'profiles:pii';
    h.respond = (name, input) => (name === 'profiles.list' ? listPage({ profiles: [row({ email: null })] }) : baseRespond(name, input));
    renderList();
    const table = await screen.findByRole('table', { name: 'People' });
    expect(within(table).getByText('Email hidden')).toBeTruthy();
    expect(within(table).getByText('Name hidden')).toBeTruthy();
    expect(screen.queryByText('Anonymous')).toBeNull();
  });

  it('says No email available when the role may see PII but the server returned none', async () => {
    h.respond = (name, input) => (name === 'profiles.list' ? listPage({ profiles: [row({ email: null })] }) : baseRespond(name, input));
    renderList();
    expect(within(await screen.findByRole('table', { name: 'People' })).getByText('No email available')).toBeTruthy();
  });

  it('issues no protected reads for a restricted role', () => {
    h.can = () => false;
    renderList();
    expect(screen.getByText(/cannot open this tab/)).toBeTruthy();
    expect(h.calls).toHaveLength(0);
  });

  it('keeps the loading, error and retry states in place', async () => {
    h.hold.add('profiles.list');
    renderList();
    expect(screen.getByLabelText('Loading people')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();

    cleanup();
    h.hold.clear();
    let failures = 1;
    h.respond = (name, input) => {
      if (name === 'profiles.list' && failures-- > 0) throw new ApiError(500, 'error', 'Server exploded');
      return baseRespond(name, input);
    };
    renderList();
    expect(await screen.findByText(/Couldn’t load people/)).toBeTruthy();
    expect(screen.getByText(/Server exploded/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByText('ada@example.com')).length).toBeGreaterThan(0);
  });
});

describe('Person detail (#510)', () => {
  it('reads the profile first and then the three timeline sources for the canonical id', async () => {
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });

    // The timeline reads start in their own effects, so the heading can render first under load.
    await waitFor(() => expect(names()).toEqual(['profiles.get', 'profiles.events', 'messages.list', 'consent.history', 'purposes.list']));
    expect(calls('profiles.events')[0].input).toEqual({ profileId: canonicalId, limit: 100 });
    expect(calls('messages.list')[0].input).toEqual({ profileId: canonicalId, limit: 50 });
    expect(calls('consent.history')[0].input).toEqual({ profileId: canonicalId });
    // No per-message template fetch and no per-row profile read.
    expect(calls('artifacts.get')).toHaveLength(0);
    expect(calls('profiles.get')).toHaveLength(1);
  });

  it('reuses purposes loaded by the list instead of reading them again', async () => {
    renderList();
    await screen.findAllByText('ada@example.com');
    cleanup();
    h.calls.length = 0;
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });
    await waitFor(() => expect(names()).toEqual(['profiles.get', 'profiles.events', 'messages.list', 'consent.history']));
  });

  it('shows the identity hierarchy and copies the full id without printing it', async () => {
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });
    expect(screen.getByRole('heading', { level: 1, name: 'ada@example.com' })).toBeTruthy();
    expect(screen.queryByText(canonicalId)).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: 'Copy person ID' })[0]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(canonicalId);
  });

  it('shows Email hidden and Name hidden without profiles:pii', async () => {
    h.can = (permission) => permission !== 'profiles:pii';
    h.respond = (name, input) =>
      name === 'profiles.get' ? profile({ personal: { email: '[hidden]', name: '[hidden]' } }) : baseRespond(name, input);
    renderPerson();
    expect(await screen.findByRole('heading', { level: 1, name: 'Email hidden' })).toBeTruthy();
    expect(screen.getAllByText('Name hidden').length).toBeGreaterThan(0);
    expect(screen.queryByText('[hidden]')).toBeNull();
  });

  it('merges events, messages, message events and consent changes in time order', async () => {
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });

    const list = await screen.findByRole('list', { name: 'Profile timeline' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Signed in'),
      expect.stringContaining('Newsletter delivered'),
      expect.stringContaining('Newsletter message'),
      expect.stringContaining('Newsletter'),
      expect.stringContaining('Viewed page'),
    ]);
    expect(within(list).getAllByText('Event').length).toBeGreaterThan(0);
    expect(within(list).getByText('Message event')).toBeTruthy();
    expect(within(list).getByText('Message')).toBeTruthy();
    expect(within(list).getByText('Consent change')).toBeTruthy();
    // Message URLs are never surfaced in a summary.
    expect(screen.queryByText(/private\.example/)).toBeNull();
  });

  it('captions the real coverage of each source and never claims completeness', async () => {
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });
    expect(await screen.findByText(/Events and consent include merged identities; messages cover the current profile only/)).toBeTruthy();
    expect(screen.getByText(/2 events loaded · 1 message loaded · 1 consent record loaded/)).toBeTruthy();
    expect(screen.getByText(/Message event history may be capped at 1,000/)).toBeTruthy();
    expect(screen.getByText(/Latest event in period: Unavailable/)).toBeTruthy();
    expect(screen.queryByText(/1970/)).toBeNull();
  });

  it('loads more events and messages with their own cursors', async () => {
    h.respond = (name, input) => {
      if (name === 'profiles.events' && input.before) return events({ events: [], nextCursor: null });
      if (name === 'messages.list' && input.cursor) return messages({ messages: [], nextCursor: null });
      return baseRespond(name, input);
    };
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });

    await userEvent.click(await screen.findByRole('button', { name: 'Load more events' }));
    await waitFor(() => expect(calls('profiles.events')).toHaveLength(2));
    expect(calls('profiles.events')[1].input).toEqual({
      profileId: canonicalId,
      limit: 100,
      before: '2026-11-06T21:42:00.000000Z',
      beforeId: 'evt_1',
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Load more messages' }));
    await waitFor(() => expect(calls('messages.list')).toHaveLength(2));
    expect(calls('messages.list')[1].input).toEqual({
      profileId: canonicalId,
      limit: 50,
      cursor: messages().nextCursor,
    });
  });

  it('keeps a failed source local and retries only that source', async () => {
    let fail = true;
    h.respond = (name, input) => {
      if (name === 'messages.list' && fail) throw new ApiError(500, 'error', 'Message store unavailable');
      return baseRespond(name, input);
    };
    renderPerson();
    expect(await screen.findByText(/Message history could not load/)).toBeTruthy();
    expect(screen.getByText('Signed in')).toBeTruthy();
    expect(screen.getByText('Allowed', { selector: 'span' })).toBeTruthy();

    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry messages' }));
    expect(await screen.findByText('Newsletter delivered')).toBeTruthy();
  });

  it('shows observed zero and unavailable separately without epoch dates', async () => {
    h.respond = (name, input) => {
      if (name === 'profiles.events') return events({ events: [], nextCursor: null });
      if (name === 'messages.list') return messages({ messages: [], nextCursor: null });
      if (name === 'consent.history') return consentHistory({ records: [] });
      return baseRespond(name, input);
    };
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });
    expect(screen.getByText(/0 events loaded · 0 messages loaded · 0 consent records loaded/)).toBeTruthy();
    expect(screen.getByText(/Latest loaded timestamp: Unavailable/)).toBeTruthy();
    expect(screen.queryByText(/1970/)).toBeNull();
  });

  it('distinguishes a person who is not there from one with no activity', async () => {
    h.respond = (name, input) => {
      if (name === 'profiles.get') throw new ApiError(404, 'not_found', 'No profile');
      return baseRespond(name, input);
    };
    renderPerson();
    expect(await screen.findByText(/This person is not available at this address/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to people' })).toBeTruthy();
    expect(calls('profiles.events')).toHaveLength(0);
  });

  it('lets the visible name win over traits and never extracts a hidden personal name', async () => {
    h.can = (permission) => permission !== 'profiles:pii';
    h.respond = (name, input) =>
      name === 'profiles.get'
        ? profile({ traits: { name: 'Trait Name' }, personal: { email: '[hidden]', name: '[hidden]' } })
        : baseRespond(name, input);
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'Email hidden' });
    expect(screen.queryByText('Trait Name')).toBeNull();
  });

  it('reads topics and segments only when their tab opens', async () => {
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });
    expect(calls('topics.preferences')).toHaveLength(0);
    expect(calls('segments.ofProfile')).toHaveLength(0);

    await userEvent.click(screen.getByRole('tab', { name: 'Topics' }));
    await waitFor(() => expect(calls('topics.preferences')).toHaveLength(1));

    await userEvent.click(screen.getByRole('tab', { name: 'Segments' }));
    await waitFor(() => expect(calls('segments.ofProfile')).toHaveLength(1));
  });

  it('issues no reads for a restricted role', () => {
    h.can = () => false;
    renderPerson();
    expect(screen.getByText(/Restricted by your role/)).toBeTruthy();
    expect(h.calls).toHaveLength(0);
  });

  it('refreshes with the four base reads, without purpose or template fan-out', async () => {
    renderPerson();
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' });
    // Let the initial timeline reads land before counting, so a slow first load is not added to the
    // four the refresh issues.
    await waitFor(() => expect(names()).toEqual(['profiles.get', 'profiles.events', 'messages.list', 'consent.history', 'purposes.list']));
    const before = h.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(h.calls.length).toBe(before + 4));
    expect(names().slice(before)).toEqual(['profiles.get', 'profiles.events', 'messages.list', 'consent.history']);
  });

  it('does not let a stale profile response replace a newer selection', async () => {
    h.hold.add('profiles.get');
    const view = renderPerson();
    await waitFor(() => expect(calls('profiles.get')).toHaveLength(1));
    view.rerender(
      <ToastProvider>
        <PersonPage params={{ id: otherId }} />
      </ToastProvider>,
    );
    await waitFor(() => expect(calls('profiles.get')).toHaveLength(2));

    // Answer the newer request first, then the old one.
    h.held[1].resolve(profile({ id: otherId, personal: { email: 'new@example.com', name: 'New Person' } }));
    expect((await screen.findAllByText('New Person')).length).toBeGreaterThan(0);
    h.held[0].resolve(profile({ id: canonicalId, personal: { email: 'old@example.com', name: 'Old Person' } }));
    await userEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.queryByText('Old Person')).toBeNull();
    expect(screen.queryByText('old@example.com')).toBeNull();
  });
});
