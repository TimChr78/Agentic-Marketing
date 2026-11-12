import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ReactElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../../../app/api';
import ConsentPage from '../../../pages/audience/ConsentPage';
import ExperiencePage from '../../../pages/build/ExperiencePage';
import ExperiencesPage from '../../../pages/build/ExperiencesPage';
import FormPage from '../../../pages/build/FormPage';
import FormsPage from '../../../pages/build/FormsPage';
import SegmentPage from '../../../pages/build/SegmentPage';
import SegmentsPage from '../../../pages/build/SegmentsPage';
import AlertsPage from '../../../pages/insights/AlertsPage';
import { ToastProvider } from '../../../ui/toast';
import { ExperienceResults } from '../../artifacts/ExperienceResults';
import { FormEditor } from '../../artifacts/FormEditor';
import { ListAudiencePanel } from '../../artifacts/ListAudiencePanel';
import { resetPickerIndexes } from '../../artifacts/pickerIndex';
import { SegmentEditor } from '../../artifacts/SegmentEditor';

// Phase 27 · audience and marketing families (#525). Every test here proves a capability from the
// source ledger still reaches the person, under the shared host template, and that repeated
// selectors cost one bounded list read instead of one read per row.

const ws = '11111111-1111-4111-8111-111111111111';

type Call = { name: string; input: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: {} as Record<string, unknown[]>,
  artifacts: {} as Record<string, unknown>,
  can: (_permission: string): boolean => true,
  memberReads: [] as string[],
  ruleHistoryError: null as Error | null,
  findMatch: true as boolean,
  consentSummary: null as unknown,
  consentRecords: [] as unknown[],
  results: null as unknown,
  previewQueue: [] as (() => Promise<unknown>)[],
}));

function callsOf(name: string) {
  return h.calls.filter((c) => c.name === name);
}

const purposeId = 'marketing_email';

function purpose() {
  return {
    key: purposeId,
    name: 'Marketing e-mail',
    description: 'News and offers by e-mail.',
    basis: 'consent',
    channels: ['email'],
    requiresDoubleOptIn: true,
    topics: [{ key: 'weekly', name: 'Weekly stories', description: '', default: 'subscribed' }],
  };
}

function row(id: string, type: string, name: string, publishedVersion: number | null = 2) {
  return {
    id,
    type,
    name,
    latestVersion: 3,
    latestState: publishedVersion === null ? 'draft' : 'published',
    publishedVersion,
    updatedAt: '2026-11-02T09:00:00.000Z',
  };
}

function artifact(id: string, type: string, name: string, content: Record<string, unknown>, publishedVersion: number | null = 2) {
  return {
    id,
    type,
    name,
    latestVersion: 3,
    publishedVersion,
    layout: null,
    references: [],
    version: {
      number: 3,
      state: publishedVersion === null ? 'draft' : 'draft',
      content,
      contentHash: 'hash',
      author: { type: 'user', id: 'u1' },
      by: {
        kind: 'person',
        displayName: 'Sam Rivera',
        personName: 'Sam Rivera',
        tokenName: null,
        tokenId: null,
        clientName: null,
      },
      note: null,
      basedOn: 2,
      createdAt: '2026-11-02T09:00:00.000Z',
    },
  };
}

const formId = `frm_${'a'.repeat(32)}`;
const segmentId = `seg_${'a'.repeat(32)}`;
const experienceId = `exp_${'a'.repeat(32)}`;
const templateId = `eml_${'b'.repeat(32)}`;
const profileId = `prf_${'c'.repeat(32)}`;

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.list') {
          const type = String(input.type ?? '');
          const rows = h.rows[type] ?? [];
          return { artifacts: rows, total: rows.length, nextCursor: null };
        }
        if (name === 'artifacts.get') {
          const found = h.artifacts[String(input.artifactId ?? input.version ?? '')];
          if (!found) throw new Error('This item does not exist.');
          return found;
        }
        if (name === 'approvals.list') return { approvals: [], total: 0, nextCursor: null };
        if (name === 'purposes.list') return { source: 'published', purposes: [purpose()] };
        if (name === 'consent.summary') return h.consentSummary;
        if (name === 'profiles.find') return h.findMatch ? { profileId } : { profileId: null };
        if (name === 'profiles.get') return { id: profileId, personal: { email: 'ada@example.com', firstName: 'Ada' }, consent: [] };
        if (name === 'consent.history') return { records: h.consentRecords };
        if (name === 'consent.record') return { recorded: true, allowed: true };
        if (name === 'hostedPages.preview') return { html: '<p>Confirm your subscription</p>' };
        if (name === 'segments.preview') {
          const next = h.previewQueue.shift();
          if (next) return await next();
          return { count: 42 };
        }
        if (name === 'segments.members') return { members: [], total: 0, nextCursor: null };
        if (name === 'audiences.imports') return { imports: h.rows.imports ?? [] };
        if (name === 'audiences.import')
          return {
            rows: 4,
            matched: 3,
            added: 2,
            existing: 1,
            unmatched: [{ row: 5, reason: 'not_found' }],
            dryRun: input.dryRun,
          };
        if (name === 'audiences.refreshSnapshot') return { members: 2, added: 1, removed: 0 };
        if (name === 'experiences.results') return h.results;
        if (name === 'alerts.list') return { rules: h.rows.alert_rules ?? [] };
        if (name === 'webhooks.list') return { endpoints: [] };
        if (name === 'members.list') return { members: [] };
        if (name === 'alerts.history') {
          if (input.ruleId) {
            if (h.ruleHistoryError) throw h.ruleHistoryError;
            return {
              events: [
                {
                  id: 'evt_rule',
                  ruleId: input.ruleId,
                  ruleName: 'Bounce ceiling',
                  state: 'resolved',
                  value: 0.03,
                  threshold: 0.05,
                  window: 'PT24H',
                  firedAt: '2026-11-02T09:00:00.000Z',
                  resolvedAt: '2026-11-02T10:00:00.000Z',
                  notified: [],
                },
              ],
            };
          }
          return { events: h.rows.alert_history ?? [] };
        }
        if (name === 'content.topics.list')
          return {
            topics: [
              {
                id: 'ctp_1',
                title: 'The next journal',
                angle: 'What to automate first',
                audience: 'Operators',
                readerRole: 'operator',
                keyword: '',
                tags: ['newsletter'],
                status: 'scored',
                score: 75,
                signals: [],
                ownerId: null,
                ownerName: 'Ada',
                targetDate: null,
                canonicalUrl: null,
                campaignId: null,
                broadcastId: null,
                dedupeKey: 'next-journal',
                similarTopicIds: [],
                briefArtifactId: null,
                createdBy: { type: 'user', id: 'u1' },
                agentId: null,
                createdAt: '2026-11-01T00:00:00.000Z',
                updatedAt: '2026-11-01T00:00:00.000Z',
              },
            ],
          };
        if (name === 'system.status')
          return {
            serverVersion: '0.12.0',
            emailProvider: { configured: true, marketing: true, transactional: true, adapter: 'ses', tracking: 'configurable' },
            pendingApprovals: 0,
          };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({
    can: (permission: string) => h.can(permission),
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  }),
  useWorkspace: () => ({
    can: (permission: string) => h.can(permission),
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  }),
}));

beforeEach(() => {
  cleanup();
  h.calls.length = 0;
  h.rows = {};
  h.artifacts = {};
  h.can = () => true;
  h.memberReads = [];
  h.ruleHistoryError = null;
  h.findMatch = true;
  h.consentRecords = [];
  h.previewQueue = [];
  h.consentSummary = {
    purposes: [
      {
        purpose: purposeId,
        granted: 240,
        denied: 2,
        withdrawn: 1,
        objected: 1,
        channels: [{ channel: 'email', granted: 230, denied: 2, withdrawn: 1, objected: 0 }],
      },
    ],
    topics: [{ purpose: purposeId, topic: 'weekly', subscribed: 120, unsubscribed: 4 }],
  };
  h.results = {
    method: 'sequential',
    version: 2,
    analysis: { method: 'sequential', alpha: 0.05, threshold: 0.95 },
    goal: 'Purchase',
    control: 'a',
    recommendation: 'Variant B is ahead.',
    note: 'Check again after more exposures.',
    variants: [
      {
        variant: 'a',
        exposed: 100,
        converted: 10,
        rate: 0.1,
        lift: 0,
        ci95: null,
        sequentialP: null,
        pValue: null,
        probBeatControl: null,
        probBest: null,
        expectedLoss: 0,
      },
      {
        variant: 'b',
        exposed: 100,
        converted: 12,
        rate: 0.12,
        lift: 0.02,
        ci95: [0.001, 0.04],
        sequentialP: 0.04,
        pValue: null,
        probBeatControl: null,
        probBest: 0.8,
        expectedLoss: 0.1,
      },
    ],
  };
  resetPickerIndexes();
  setWorkspaceId(ws, { persist: false });
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
});

function renderWithToast(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

function estimateText() {
  return screen.getByText('Estimated size now').parentElement?.textContent ?? '';
}

function pendingCount() {
  let resolve!: (value: { count: number }) => void;
  const promise = new Promise<{ count: number }>((done) => {
    resolve = done;
  });
  return { promise, resolve: (count: number) => resolve({ count }) };
}

const formContent = {
  purposes: [purposeId],
  doubleOptIn: true,
  confirmationTemplate: templateId,
  consentText: 'Send me the newsletter. I can unsubscribe at any time.',
  traits: ['firstName'],
  successUrl: '/thanks',
  allowedOrigins: ['https://example.com'],
  turnstile: false,
};

describe('forms family (#525)', () => {
  it('keeps every list field and action in the v2 list template, including the phone summary', async () => {
    h.rows.form = [row(formId, 'form', 'Weekly journal')];
    renderWithToast(<FormsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Forms' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Forms on a phone' })).toBeTruthy();
    const phone = screen.getByRole('list', { name: 'Forms on a phone' });
    expect(within(phone).getByRole('link', { name: 'Weekly journal' }).getAttribute('href')).toBe(`/audience/forms/${formId}`);
    expect(within(phone).getByText('Published v2')).toBeTruthy();
    expect(within(phone).getByText(/Updated/)).toBeTruthy();
    expect(screen.getByLabelText('Search forms')).toBeTruthy();
    expect(screen.getByLabelText('Publication state')).toBeTruthy();
    expect(screen.getByText('1 form')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    expect(screen.getByRole('dialog', { name: 'New form' })).toBeTruthy();
    expect(screen.getByLabelText(/Confirmation e-mail/)).toBeTruthy();
    // Opening create adds exactly one bounded template list for the selector, never one read per row.
    await waitFor(() => expect(callsOf('artifacts.list')).toHaveLength(2));
    expect(callsOf('artifacts.get')).toHaveLength(0);
  });

  it('keeps consent, fields, redirects, security and hosted-page overrides on the detail, with a local preview', async () => {
    h.rows.form = [row(formId, 'form', 'Weekly journal')];
    h.artifacts[formId] = artifact(formId, 'form', 'Weekly journal', formContent);
    h.rows.email_template = [row(templateId, 'email_template', 'Confirm your subscription')];
    renderWithToast(<FormPage params={{ id: formId }} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly journal' })).toBeTruthy();
    expect(screen.getByText('Form')).toBeTruthy();
    for (const tab of ['Content', 'Preview', /^Versions/, 'Activity']) {
      expect(screen.getByRole('tab', { name: tab })).toBeTruthy();
    }
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeTruthy();
    expect(screen.getByText('Saved v3 preview')).toBeTruthy();

    // Every section is reachable; collapsed sections keep their values mounted.
    expect(await screen.findByLabelText(/^Consent text/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: /Double opt-in/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('firstName')).toBeTruthy();
    expect(screen.getByLabelText(/^Success page/)).toBeTruthy();
    expect(screen.getByLabelText('Confirmed page')).toBeTruthy();
    expect(screen.getByLabelText('Error page')).toBeTruthy();
    expect(screen.getByLabelText('Allowed sites')).toBeTruthy();
    expect(screen.getByRole('switch', { name: /Turnstile/ })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /different look/ })).toBeTruthy();

    // The context preview follows unsaved changes and stays local: no artifacts.get per preview.
    fireEvent.change(screen.getByLabelText(/^Consent text/), { target: { value: 'Fresh wording for the review.' } });
    expect(screen.getByText('Unsaved draft preview')).toBeTruthy();
    expect(within(screen.getByRole('complementary', { name: 'Context' })).getByText('Fresh wording for the review.')).toBeTruthy();

    // The hosted confirm renderer is read only once the disclosure is opened.
    expect(callsOf('hostedPages.preview')).toHaveLength(0);
    fireEvent.click(screen.getByText('Hosted pages'));
    await waitFor(() => expect(callsOf('hostedPages.preview')).toHaveLength(1));

    expect(callsOf('artifacts.get')).toHaveLength(1);
    expect(callsOf('purposes.list')).toHaveLength(1);
  });

  it('preserves a form brand override while the override switch is turned off and on again', async () => {
    function Harness() {
      const [content, setContent] = useState<Record<string, unknown>>({
        consentText: 'Send me the newsletter.',
        traits: ['firstName'],
      });
      return (
        <FormEditor
          artifact={artifact(formId, 'form', 'Weekly journal', content) as never}
          content={content as never}
          onChange={(next) => setContent(next as unknown as Record<string, unknown>)}
          readOnly={false}
          errors={{}}
          warnings={[]}
        />
      );
    }
    h.artifacts[formId] = artifact(formId, 'form', 'Weekly journal', formContent);
    renderWithToast(<Harness />);

    const override = screen.getByRole('switch', { name: /different look/ });
    fireEvent.click(override);
    const accent = screen.getByRole('textbox', { name: 'Accent colour' });
    fireEvent.change(accent, { target: { value: '#123456' } });
    expect((accent as HTMLInputElement).value).toBe('#123456');

    fireEvent.click(screen.getByRole('switch', { name: /different look/ }));
    expect(screen.queryByRole('textbox', { name: 'Accent colour' })).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: /different look/ }));
    expect((screen.getByRole('textbox', { name: 'Accent colour' }) as HTMLInputElement).value).toBe('#123456');
  });
});

describe('segments family (#525)', () => {
  it('lists segments on the template and reads the snapshot source once for every row', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    renderWithToast(<SegmentsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Segments' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Segments on a phone' })).toBeTruthy();
    expect(screen.getByText('1 segment')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New segment' }));
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'snapshot' } });
    const source = screen.getByLabelText('Source segment');
    await waitFor(() => expect(within(source).getByRole('option', { name: /Weekly readers · v2/ })).toBeTruthy());
    expect(callsOf('artifacts.list').filter((c) => c.input.type === 'segment')).toHaveLength(1);
    expect(callsOf('artifacts.get')).toHaveLength(0);
  });

  it('shares one segment index and one purposes read across a hundred conditions', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const conditions = Array.from({ length: 100 }, () => ({ segment: segmentId }));
    const content = { mode: 'dynamic', condition: { all: conditions } };
    renderWithToast(
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', content) as never}
        content={content as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    await waitFor(() => expect(screen.getAllByLabelText(/^Segment, condition/).length).toBe(100));
    await waitFor(() => expect(callsOf('artifacts.list')).toHaveLength(1));
    expect(callsOf('purposes.list')).toHaveLength(1);
    expect(callsOf('artifacts.get')).toHaveLength(0);
  });

  it('shares one purposes read across nested consent conditions and keeps the estimate explicit', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const content = {
      mode: 'dynamic',
      condition: { any: Array.from({ length: 100 }, () => ({ consent: purposeId })) },
    };
    renderWithToast(
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', content) as never}
        content={content as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    await waitFor(() => expect(callsOf('purposes.list')).toHaveLength(1));
    expect(screen.getAllByLabelText(/^Purpose, condition/).length).toBe(100);
    expect(callsOf('segments.preview')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    expect(await screen.findByText('42')).toBeTruthy();
    expect(callsOf('segments.preview')).toHaveLength(1);
    expect(callsOf('segments.preview')[0].input).toMatchObject({ condition: { any: conditionsOf(content) } });
  });

  it('marks an estimate as previous once the rules change', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const pending = pendingCount();
    h.previewQueue = [() => pending.promise];
    const first = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'gold' } };
    const second = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'silver' } };
    const { rerender } = renderWithToast(
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', first) as never}
        content={first as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(callsOf('segments.preview')).toHaveLength(1));
    pending.resolve(42);
    await waitFor(() => expect(estimateText()).toContain('42 people'));

    rerender(
      <ToastProvider>
        <SegmentEditor
          artifact={artifact(segmentId, 'segment', 'Weekly readers', second) as never}
          content={second as never}
          onChange={() => {}}
          readOnly={false}
          errors={{}}
          warnings={[]}
        />
      </ToastProvider>,
    );
    expect(estimateText()).toContain('last estimate was 42 people, for the previous rules');
  });

  it('ignores a late estimate for rules the person has already edited', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const pending = pendingCount();
    h.previewQueue = [() => pending.promise];
    const first = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'gold' } };
    const second = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'silver' } };
    const { rerender } = renderWithToast(
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', first) as never}
        content={first as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(callsOf('segments.preview')).toHaveLength(1));

    rerender(
      <ToastProvider>
        <SegmentEditor
          artifact={artifact(segmentId, 'segment', 'Weekly readers', second) as never}
          content={second as never}
          onChange={() => {}}
          readOnly={false}
          errors={{}}
          warnings={[]}
        />
      </ToastProvider>,
    );
    pending.resolve(99);
    await waitFor(() => expect(estimateText()).toContain('previous estimate was not applied'));
    expect(estimateText()).not.toContain('99 people');
  });

  it('settles an abandoned estimate so returning to its rules leaves Estimate again usable', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const pending = pendingCount();
    h.previewQueue = [() => pending.promise];
    const first = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'gold' } };
    const second = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'silver' } };
    const editor = (content: Record<string, unknown>) => (
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', content) as never}
        content={content as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />
    );
    const { rerender } = renderWithToast(editor(first));
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(callsOf('segments.preview')).toHaveLength(1));

    rerender(<ToastProvider>{editor(second)}</ToastProvider>);
    await waitFor(() => expect(estimateText()).toContain('previous estimate was not applied'));

    // The abandoned response arrives while the other rules are on screen and is ignored.
    pending.resolve(99);
    await waitFor(() => expect(estimateText()).toContain('previous estimate was not applied'));
    expect(estimateText()).not.toContain('99 people');

    // Returning to the first rules must not restore a permanently loading estimate.
    rerender(<ToastProvider>{editor(first)}</ToastProvider>);
    expect(estimateText()).toContain('estimate was not applied');
    const again = screen.getByRole('button', { name: 'Estimate again' }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
  });

  it('does not let an obsolete response settle the newer request for the same rules', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const older = pendingCount();
    const newer = pendingCount();
    h.previewQueue = [() => older.promise, () => newer.promise];
    const first = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'gold' } };
    const second = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'silver' } };
    const editor = (content: Record<string, unknown>) => (
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', content) as never}
        content={content as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />
    );
    const { rerender } = renderWithToast(editor(first));
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(callsOf('segments.preview')).toHaveLength(1));

    rerender(<ToastProvider>{editor(second)}</ToastProvider>);
    await waitFor(() => expect(estimateText()).toContain('previous estimate was not applied'));
    rerender(<ToastProvider>{editor(first)}</ToastProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Estimate again' }));
    await waitFor(() => expect(callsOf('segments.preview')).toHaveLength(2));

    // The first request for these rules resolves while the second one is still pending.
    older.resolve(11);
    await waitFor(() => expect(estimateText()).not.toContain('11 people'));
    expect(estimateText()).not.toContain('was not applied');
    expect((screen.getByRole('button', { name: 'Estimate again' }) as HTMLButtonElement).disabled).toBe(true);

    newer.resolve(22);
    await waitFor(() => expect(estimateText()).toContain('22 people'));
    expect((screen.getByRole('button', { name: 'Estimate again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores an estimate that completes after a newer one', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const older = pendingCount();
    const newer = pendingCount();
    h.previewQueue = [() => older.promise, () => newer.promise];
    const first = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'gold' } };
    const second = { mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'silver' } };
    const { rerender } = renderWithToast(
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', first) as never}
        content={first as never}
        onChange={() => {}}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Estimate audience' }));
    await waitFor(() => expect(callsOf('segments.preview')).toHaveLength(1));

    rerender(
      <ToastProvider>
        <SegmentEditor
          artifact={artifact(segmentId, 'segment', 'Weekly readers', second) as never}
          content={second as never}
          onChange={() => {}}
          readOnly={false}
          errors={{}}
          warnings={[]}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Estimate/ }));
    await waitFor(() => expect(callsOf('segments.preview')).toHaveLength(2));
    newer.resolve(7);
    await waitFor(() => expect(estimateText()).toContain('7 people'));

    older.resolve(99);
    await waitFor(() => expect(estimateText()).not.toContain('99 people'));
    expect(estimateText()).toContain('7 people');
  });

  it('keeps the detail template, the advanced condition view and the audience panel', async () => {
    const content = { mode: 'static', description: 'Hand-picked readers.' };
    h.artifacts[segmentId] = artifact(segmentId, 'segment', 'Weekly readers', content);
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    renderWithToast(<SegmentPage params={{ id: segmentId }} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly readers' })).toBeTruthy();
    expect(screen.getByText('Segment')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeTruthy();
    expect(screen.getAllByText(/Membership is not consent\./).length).toBeGreaterThan(0);
    expect(await screen.findByText('Import history')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add people' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import CSV' })).toBeTruthy();
    await waitFor(() => expect(callsOf('segments.members')).toHaveLength(1));
    expect(callsOf('audiences.imports')).toHaveLength(1);
  });

  it('keeps nested, self and missing segment references and round-trips unknown condition keys', async () => {
    h.rows.segment = [row(segmentId, 'segment', 'Weekly readers')];
    const captured: Record<string, unknown>[] = [];
    const content = {
      mode: 'dynamic',
      condition: {
        all: [
          { trait: 'loyaltyTier', op: 'eq', value: 'gold', future: { nested: true } },
          { all: [{ trait: 'country', op: 'eq', value: 'DE' }] },
          { segment: segmentId },
          { segment: `seg_${'f'.repeat(32)}` },
        ],
      },
    };
    renderWithToast(
      <SegmentEditor
        artifact={artifact(segmentId, 'segment', 'Weekly readers', content) as never}
        content={content as never}
        onChange={(next) => captured.push(next as unknown as Record<string, unknown>)}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    await waitFor(() => expect(screen.getAllByLabelText(/^Segment, condition/).length).toBe(2));
    expect(screen.getAllByLabelText(/Match all or any/)).toHaveLength(2);
    expect(screen.getAllByText(/this segment or not found/)).toHaveLength(2);

    fireEvent.change(screen.getAllByLabelText(/^Operator, condition/)[0], { target: { value: 'neq' } });
    const last = captured.at(-1) as Record<string, unknown>;
    const all = (last.condition as { all: Record<string, unknown>[] }).all;
    expect(all[0]).toMatchObject({ trait: 'loyaltyTier', op: 'neq', value: 'gold', future: { nested: true } });
    expect(all[1]).toEqual({ all: [{ trait: 'country', op: 'eq', value: 'DE' }] });
  });

  it('keeps the CSV dry-run, unmatched rows and import history', async () => {
    h.rows.imports = [
      {
        id: 'imp_1',
        source: 'csv',
        fileName: 'people.csv',
        rows: 4,
        matched: 3,
        added: 2,
        unmatched: [{ row: 5, reason: 'not_found' }],
        createdAt: '2026-11-02T09:00:00.000Z',
      },
    ];
    renderWithToast(<ListAudiencePanel artifactId={segmentId} content={{ mode: 'static' }} />);
    expect(await screen.findByText('people.csv')).toBeTruthy();
    expect(screen.getByText(/1 unmatched/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }));
    const csv = 'email\nada@example.com\nbo@example.com\n';
    fireEvent.change(screen.getByLabelText('CSV file'), {
      target: { files: [new File([csv], 'people.csv', { type: 'text/csv' })] },
    });
    const column = await screen.findByLabelText('Column with the identifier');
    fireEvent.change(column, { target: { value: 'email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview matches' }));
    await waitFor(() => expect(callsOf('audiences.import')).toHaveLength(1));
    expect(callsOf('audiences.import')[0].input).toMatchObject({ dryRun: true, column: 'email' });
    expect(await screen.findByText('Unmatched rows')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Apply 2 additions/ }));
    await waitFor(() => expect(callsOf('audiences.import')).toHaveLength(2));
    expect(callsOf('audiences.import')[1].input).toMatchObject({ dryRun: false });
  });

  it('refreshes a snapshot and refetches only the affected members and imports', async () => {
    renderWithToast(
      <ListAudiencePanel
        artifactId={segmentId}
        content={{
          mode: 'snapshot',
          sourceSegment: segmentId,
          snapshotVersion: 2,
          snapshotAt: '2026-11-02T09:00:00.000Z',
        }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh from source' }));
    await waitFor(() => expect(callsOf('audiences.refreshSnapshot')).toHaveLength(1));
    await waitFor(() => expect(callsOf('segments.members')).toHaveLength(2));
    expect(callsOf('audiences.imports')).toHaveLength(2);
  });
});

function conditionsOf(content: Record<string, unknown>) {
  const condition = content.condition as { any?: unknown[] } | undefined;
  return condition?.any ?? [];
}

describe('web experiences family (#525)', () => {
  it('lists experiences on the template and keeps the Results tab access', async () => {
    h.rows.experience = [row(experienceId, 'experience', 'Article banner')];
    renderWithToast(<ExperiencesPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Experiences' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Experiences on a phone' })).toBeTruthy();
    expect(screen.getByText('1 experience')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New experience' }));
    expect(screen.getByRole('dialog', { name: 'New experience' })).toBeTruthy();
  });

  it('keeps placement, trigger, targeting, variants, holdout and analysis on the detail', async () => {
    const content = {
      placement: 'article-footer',
      description: 'Newsletter banner under articles.',
      variants: [{ id: 'a', name: 'Variant A', weight: 50, content: { html: '<p>Read the next issue</p>' } }],
      holdoutPercent: 10,
      goal: { event: 'Purchase' },
      analysis: { method: 'sequential', alpha: 0.05, threshold: 0.95 },
    };
    h.artifacts[experienceId] = artifact(experienceId, 'experience', 'Article banner', content);
    h.rows.experience = [row(experienceId, 'experience', 'Article banner')];
    renderWithToast(<ExperiencePage params={{ id: experienceId }} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Article banner' })).toBeTruthy();
    expect(screen.getByText('Web experience')).toBeTruthy();
    for (const tab of ['Content', 'Preview', 'Results', /^Versions/, 'Activity']) {
      expect(screen.getByRole('tab', { name: tab })).toBeTruthy();
    }
    expect(await screen.findByLabelText(/^Placement/)).toBeTruthy();
    expect(screen.getByLabelText('Priority')).toBeTruthy();
    expect(screen.getByLabelText('Trigger')).toBeTruthy();
    expect(screen.getByLabelText('Targeting')).toBeTruthy();
    expect(screen.getByLabelText('Name of variant 1')).toBeTruthy();
    expect(screen.getByLabelText('Weight of variant 1')).toBeTruthy();
    expect(screen.getByLabelText('Content kind for variant 1')).toBeTruthy();
    expect(screen.getByLabelText('HTML for variant 1')).toBeTruthy();
    expect(screen.getByLabelText('Holdout')).toBeTruthy();
    expect(screen.getByLabelText('Goal event')).toBeTruthy();
    expect(screen.getByLabelText('Analysis')).toBeTruthy();
    expect(screen.getByLabelText('Alpha')).toBeTruthy();
    expect(screen.getByLabelText('Threshold')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeTruthy();
  });

  it('shows intervals as text, not only on hover, and reports the period honestly', async () => {
    h.artifacts[experienceId] = artifact(experienceId, 'experience', 'Article banner', {
      variants: [{ id: 'a', name: 'Variant A', weight: 100, content: { html: '' } }],
    });
    const artifactValue = h.artifacts[experienceId] as { version: { content: { analysis?: unknown } } };
    artifactValue.version.content.analysis = { method: 'sequential', alpha: 0.05, threshold: 0.95 };
    renderWithToast(<ExperienceResults artifact={artifactValue as never} />);
    expect(await screen.findByRole('table', { name: 'Experiment results' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '95% interval' })).toBeTruthy();
    expect(screen.getByText('0.1 points to 4.0 points')).toBeTruthy();
    expect(screen.getByText(/Period and freshness unavailable/)).toBeTruthy();
    expect(screen.queryByText(/hover a lift/)).toBeNull();
    expect(callsOf('experiences.results')).toHaveLength(1);
  });

  it('does not collect results before the experience is published', () => {
    h.artifacts[experienceId] = artifact(experienceId, 'experience', 'Article banner', {}, null);
    renderWithToast(<ExperienceResults artifact={h.artifacts[experienceId] as never} />);
    expect(screen.getByText('No results yet')).toBeTruthy();
    expect(callsOf('experiences.results')).toHaveLength(0);
  });
});

function alertRule(id: string, name: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    name,
    kind: 'deliverability',
    enabled: true,
    state: 'ok',
    firingSince: null,
    config: { metric: 'bounce', threshold: 0.05, window: 'PT24H', minSent: 100 },
    channels: [{ type: 'email', userIds: ['u1'] }],
    ...patch,
  };
}

describe('alerts (#525)', () => {
  it('keeps every rule, condition, state and action in one bounded list', async () => {
    h.rows.alert_rules = [
      alertRule('alr_1', 'Bounce ceiling'),
      alertRule('alr_2', 'Journey errors', {
        kind: 'journey_errors',
        enabled: false,
        config: { window: 'PT1H', threshold: 10 },
        channels: [],
      }),
    ];
    h.rows.journey = [];
    h.rows.alert_history = [];
    h.can = () => true;
    renderWithToast(<AlertsPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Alerts' })).toBeTruthy();
    const bounce = screen.getByRole('heading', { name: 'Bounce ceiling' }).closest('section') as HTMLElement;
    expect(within(bounce).getByText(/Bounce rate above 5.0% over 24 hours/)).toBeTruthy();
    expect(within(bounce).getByText('Not firing')).toBeTruthy();
    expect(within(bounce).getByRole('button', { name: 'History' })).toBeTruthy();
    expect(within(bounce).getByRole('button', { name: 'Send a test' })).toBeTruthy();
    expect(within(bounce).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(bounce).getByRole('button', { name: 'Delete Bounce ceiling' })).toBeTruthy();

    const journey = screen.getByRole('heading', { name: 'Journey errors' }).closest('section') as HTMLElement;
    expect(within(journey).getByText('Paused')).toBeTruthy();

    // The rule description still carries the kind and channel, not just the name.
    expect(within(bounce).getByText('Deliverability')).toBeTruthy();
    expect(within(bounce).getByText(/E-mail 1 person/)).toBeTruthy();

    // One read each on cold load; members only for workspace admins.
    expect(callsOf('alerts.list')).toHaveLength(1);
    expect(callsOf('webhooks.list')).toHaveLength(1);
    expect(callsOf('artifacts.list')).toHaveLength(1);
    expect(callsOf('alerts.history').filter((c) => !c.input.ruleId)).toHaveLength(1);
    expect(callsOf('members.list')).toHaveLength(1);
    expect(screen.getByText(/does not by itself show healthy traffic/)).toBeTruthy();

    // Opening one rule's history adds exactly one read with its own limit.
    fireEvent.click(within(bounce).getByRole('button', { name: 'History' }));
    await waitFor(() => expect(callsOf('alerts.history').filter((c) => c.input.ruleId === 'alr_1')).toHaveLength(1));
    const ruleHistory = callsOf('alerts.history').filter((c) => c.input.ruleId === 'alr_1')[0];
    expect(ruleHistory.input).toMatchObject({ ruleId: 'alr_1', limit: 200 });

    // The rule editor keeps kind-specific fields and fixes the kind after creation.
    fireEvent.click(within(bounce).getByRole('button', { name: 'Edit' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit Bounce ceiling' });
    expect((within(drawer).getByLabelText('Kind') as HTMLSelectElement).disabled).toBe(true);
    expect(within(drawer).getByLabelText('Measure')).toBeTruthy();
    expect(within(drawer).getByLabelText('Window')).toBeTruthy();
    expect(within(drawer).getByLabelText('Threshold')).toBeTruthy();
    expect(within(drawer).getByLabelText('Minimum sent')).toBeTruthy();
    expect(within(drawer).getByText('Notify')).toBeTruthy();
    expect(within(drawer).getByRole('checkbox', { name: 'Enabled' })).toBeTruthy();
  });

  it('gives a failed rule history its own Retry', async () => {
    h.rows.alert_rules = [alertRule('alr_1', 'Bounce ceiling')];
    h.rows.alert_history = [];
    h.ruleHistoryError = new Error('The history is unavailable.');
    renderWithToast(<AlertsPage />);
    const bounce = (await screen.findByRole('heading', { name: 'Bounce ceiling' })).closest('section') as HTMLElement;
    fireEvent.click(within(bounce).getByRole('button', { name: 'History' }));
    expect(await screen.findByText("Couldn't load this rule's history")).toBeTruthy();
    h.ruleHistoryError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Resolved')).toBeTruthy();
  });
});

describe('consent, purposes and editorial topics (#525)', () => {
  it('keeps the purpose summary, person lookup, append-only ledger and record drawer', async () => {
    h.consentRecords = [
      {
        purpose: purposeId,
        channel: 'email',
        status: 'granted',
        basis: 'consent',
        source: 'form',
        proof: { note: 'Newsletter checkbox v3' },
        recordedAt: '2026-11-02T09:00:00.000Z',
        recordedBy: 'u1',
      },
    ];
    renderWithToast(<ConsentPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Consent' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Consent' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Purposes' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Editorial topics' })).toBeTruthy();

    expect(screen.getByRole('heading', { name: 'Consent by purpose' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Purposes' })).toBeTruthy();
    expect(screen.getByText('Marketing e-mail')).toBeTruthy();
    expect(screen.getByText('240 allowed')).toBeTruthy();
    expect(screen.getByText('4 refused')).toBeTruthy();
    expect(screen.getByText(/E-mail: 230 allowed, 3 refused/)).toBeTruthy();
    expect(screen.getByText(/weekly: 120 subscribed/)).toBeTruthy();
    expect(screen.getByText(/A person with no record is not counted as a refusal/)).toBeTruthy();
    expect(screen.getAllByText(/append-only/).length).toBeGreaterThan(0);

    // Email lookup: one find, then the profile and history reads.
    fireEvent.change(screen.getByLabelText('E-mail or profile id'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(callsOf('profiles.find')).toHaveLength(1);
    expect(callsOf('profiles.get')).toHaveLength(1);
    expect(callsOf('consent.history')).toHaveLength(1);
    expect(screen.getByRole('table', { name: 'Consent ledger' })).toBeTruthy();
    expect(screen.getByText(/Newsletter checkbox v3/)).toBeTruthy();

    // Recording appends one row and refreshes the selected person and summary only.
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    const drawer = screen.getByRole('dialog', { name: 'Record consent' });
    fireEvent.change(within(drawer).getByLabelText(/^Choice/), { target: { value: 'withdrawn' } });
    fireEvent.change(within(drawer).getByLabelText('Channel'), { target: { value: 'email' } });
    fireEvent.change(within(drawer).getByLabelText('Where it came from'), { target: { value: 'unsubscribe' } });
    fireEvent.change(within(drawer).getByLabelText('Proof note'), { target: { value: 'Unsubscribe link, 2026-11-08' } });
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Record consent' }).at(-1)!);
    await waitFor(() => expect(callsOf('consent.record')).toHaveLength(1));
    expect(callsOf('consent.record')[0].input).toMatchObject({
      purpose: purposeId,
      status: 'withdrawn',
      channel: 'email',
      source: 'unsubscribe',
      proof: { note: 'Unsubscribe link, 2026-11-08' },
    });
    await waitFor(() => expect(callsOf('consent.summary')).toHaveLength(2));
    expect(callsOf('profiles.get')).toHaveLength(2);
    expect(callsOf('consent.history')).toHaveLength(2);
  });

  it('keeps the purposes in force and the editorial queue as separate tabs', async () => {
    h.artifacts[`prm_${'d'.repeat(32)}`] = artifact(`prm_${'d'.repeat(32)}`, 'purposes', 'Purposes', { purposes: [] });
    h.rows.purposes = [row(`prm_${'d'.repeat(32)}`, 'purposes', 'Purposes')];
    renderWithToast(<ConsentPage />);
    await screen.findByRole('heading', { level: 1, name: 'Consent' });

    fireEvent.click(screen.getByRole('tab', { name: 'Purposes' }));
    expect(await screen.findByRole('heading', { name: 'Purposes in force' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Purposes' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit purposes' })).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Editorial topics' }));
    expect(await screen.findByRole('heading', { name: 'Editorial topics' })).toBeTruthy();
    expect(screen.getByText(/not subscriber topic preferences/)).toBeTruthy();
    expect(screen.getByLabelText('Filter by owner')).toBeTruthy();
    expect(screen.getByLabelText('Filter by tag')).toBeTruthy();
    expect(screen.getByLabelText('Filter by status')).toBeTruthy();
    expect(screen.getByLabelText('Minimum score')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New topic' })).toBeTruthy();
    expect(await screen.findByText('The next journal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Brief' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive The next journal' })).toBeTruthy();
  });

  it('issues no denied reads when the role cannot read profiles', async () => {
    h.can = (permission) => permission === 'artifacts:read';
    renderWithToast(<ConsentPage />);
    expect(await screen.findByText("Your role can't open this tab")).toBeTruthy();
    expect(callsOf('consent.summary')).toHaveLength(0);
    expect(callsOf('profiles.find')).toHaveLength(0);
    expect(callsOf('profiles.get')).toHaveLength(0);
    expect(callsOf('consent.history')).toHaveLength(0);
  });
});
