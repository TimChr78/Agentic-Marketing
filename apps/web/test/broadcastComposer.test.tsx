import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateArtifact } from '../src/features/artifactCache';
import type { Artifact } from '../src/features/artifacts/ArtifactDetailPage';
import { BroadcastEditor } from '../src/features/artifacts/BroadcastEditor';
import {
  type ComposerBroadcastContent,
  type ComposerEstimate,
  type ComposerPurpose,
  type ComposerSendingDomains,
  type ComposerSystemStatus,
  channelOfTemplate,
  consentCheck,
  daysLabel,
  domainCheck,
  estimateSummary,
  humanDuration,
  previewSourceFor,
  providerCheck,
  streamOfBasis,
  templateCheck,
  windowSummary,
} from '../src/features/broadcasts/composer/model';
import { setWorkspaceTimeZone } from '../src/ui/time';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown }[],
  can: (_permission: string): boolean => true,
  failProvider: false,
}));

const id = `bct_${'a'.repeat(32)}`;
const tpl = `eml_${'c'.repeat(32)}`;
const tplDraft = `eml_${'d'.repeat(32)}`;
const seg = `seg_${'b'.repeat(32)}`;
const seg2 = `seg_${'e'.repeat(32)}`;

const purposes: ComposerPurpose[] = [
  {
    key: 'marketing_email',
    name: 'Marketing e-mail',
    description: 'News and offers by e-mail.',
    basis: 'consent',
    channels: ['email'],
    requiresDoubleOptIn: true,
    topics: [{ key: 'newsletter', name: 'Weekly newsletter', description: 'The Friday issue', default: 'subscribed' }],
  },
  {
    key: 'onboarding',
    name: 'Service messages',
    description: 'Messages about your account.',
    basis: 'contract',
    channels: ['email'],
    requiresDoubleOptIn: false,
    topics: [],
  },
  {
    key: 'marketing_sms',
    name: 'Marketing SMS',
    description: 'News and offers by text.',
    basis: 'consent',
    channels: ['sms'],
    requiresDoubleOptIn: false,
    topics: [],
  },
];

const templateArtifact = {
  id: tpl,
  type: 'email_template',
  name: 'Weekly Signal #43',
  latestVersion: 5,
  publishedVersion: 5,
  version: {
    number: 5,
    state: 'published',
    author: { type: 'user', id: 'person_1' },
    content: { purpose: 'marketing_email', topic: 'newsletter' },
  },
  layout: null,
  references: [],
};

const draftTemplateArtifact = {
  ...templateArtifact,
  id: tplDraft,
  name: 'Draft issue',
  publishedVersion: null,
  latestVersion: 2,
  version: { ...templateArtifact.version, number: 2, state: 'draft' },
};

const segmentArtifact = (artifactId: string, name: string) => ({
  id: artifactId,
  type: 'segment',
  name,
  latestVersion: 1,
  publishedVersion: 1,
  version: {
    number: 1,
    state: 'published',
    author: { type: 'user', id: 'person_1', client: null },
    content: {},
  },
  layout: null,
  references: [],
});

const estimate: ComposerEstimate = {
  audience: 12480,
  checked: 2000,
  wouldSend: 1842,
  wouldSkip: { no_consent: 110, unsubscribed: 30, suppressed: 18, frequency_cap: 0 },
  sendAt: null,
  sendWindow: null,
  subjectTest: null,
};

const systemStatus: ComposerSystemStatus = {
  serverVersion: '0.11.0',
  emailProvider: { configured: true, marketing: true, transactional: true, adapter: 'ses', tracking: 'configurable' },
  pendingApprovals: 0,
};

const sendingDomains: ComposerSendingDomains = {
  checkedAt: '2026-11-06T10:32:00Z',
  domains: [
    {
      domain: 'mail.martechsignal.example',
      ok: true,
      uses: ['marketing'],
      spf: { ok: true, record: 'v=spf1 include:amazonses.com ~all', advice: null },
      dmarc: { ok: true, record: 'v=DMARC1; p=none', policy: 'none', advice: null },
      dkim: [],
    },
  ],
};

const withDomains = (domains: ComposerSendingDomains['domains']): ComposerSendingDomains => ({
  checkedAt: '2026-11-06T10:32:00Z',
  domains,
});

const purpose = (key: string) => purposes.find((p) => p.key === key);

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        switch (name) {
          case 'artifacts.get': {
            if (input.artifactId === seg) return segmentArtifact(seg, 'Engaged readers');
            if (input.artifactId === seg2) return segmentArtifact(seg2, 'All readers');
            const artifact = input.artifactId === tplDraft ? draftTemplateArtifact : templateArtifact;
            return {
              ...artifact,
              version: { ...artifact.version, number: (input.version as number | undefined) ?? artifact.latestVersion },
            };
          }
          case 'artifacts.list':
            return {
              artifacts: [
                {
                  id: tpl,
                  type: 'email_template',
                  name: 'Weekly Signal #43',
                  latestVersion: 5,
                  latestState: 'published',
                  publishedVersion: 5,
                  updatedAt: '',
                },
                {
                  id: tplDraft,
                  type: 'email_template',
                  name: 'Draft issue',
                  latestVersion: 2,
                  latestState: 'draft',
                  publishedVersion: null,
                  updatedAt: '',
                },
                {
                  id: seg,
                  type: 'segment',
                  name: 'Engaged readers',
                  latestVersion: 1,
                  latestState: 'published',
                  publishedVersion: 1,
                  updatedAt: '',
                },
                {
                  id: seg2,
                  type: 'segment',
                  name: 'All readers',
                  latestVersion: 1,
                  latestState: 'published',
                  publishedVersion: 1,
                  updatedAt: '',
                },
              ],
              total: 4,
              nextCursor: null,
            };
          case 'purposes.list':
            return { source: 'published', purposes };
          case 'system.status':
            if (h.failProvider) throw new Error('Provider status unavailable');
            return systemStatus;
          case 'sendingDomains.list':
            return sendingDomains;
          case 'broadcasts.preview':
            return estimate;
          case 'templates.preview':
            return {
              version: (input.version as number | undefined) ?? 5,
              subject: 'Weekly Signal #43',
              preheader: 'This week',
              html: '<html><body><p>Hi Ada</p></body></html>',
              text: 'Hi Ada',
              warnings: [],
            };
          case 'templates.check':
            return {
              version: (input.version as number | undefined) ?? 5,
              findings: [],
              checkedAt: '2026-11-06T10:32:00Z',
              summary: { blocking: 0, warning: 0, info: 0 },
            };
          default:
            throw new Error(`unexpected command ${name}`);
        }
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useWorkspace: () => ({
    can: (permission: string) => h.can(permission),
    workspace: { id: 'ws_1', approvalPolicy: 'none' },
    user: { id: 'u1' },
  }),
}));

const content = (overrides: Partial<ComposerBroadcastContent> = {}): ComposerBroadcastContent => ({
  template: tpl,
  segment: seg,
  sendAt: '2026-11-09T09:00:00Z',
  sendWindow: { start: '09:00', end: '17:00', maxDelay: 'P1D' },
  ...overrides,
});

function artifactFor(version: number, value: ComposerBroadcastContent): Artifact {
  return {
    id,
    type: 'broadcast',
    name: 'Weekly Signal #43',
    latestVersion: version,
    publishedVersion: null,
    version: {
      number: version,
      state: 'draft',
      author: { type: 'user', id: 'person_1', client: null },
      by: { kind: 'person', displayName: 'Sam Rivera', personName: 'Sam Rivera', tokenName: null, tokenId: null, clientName: null },
      note: null,
      contentHash: `hash${version}`,
      basedOn: version - 1,
      createdAt: '2026-11-05T15:20:00Z',
      content: value,
    },
    layout: null,
    references: [value.template, value.segment].filter((reference): reference is string => !!reference),
  };
}

function Harness({
  initial = content(),
  readOnly = false,
  value = artifactFor(4, initial),
}: {
  initial?: ComposerBroadcastContent;
  readOnly?: boolean;
  value?: ReturnType<typeof artifactFor>;
}) {
  const [draft, setDraft] = useState(initial);
  return <BroadcastEditor artifact={value} content={draft} onChange={setDraft} readOnly={readOnly} errors={{}} warnings={[]} />;
}

const calls = (name: string) => h.calls.filter((call) => call.name === name);

beforeEach(() => {
  cleanup();
  h.calls.length = 0;
  h.can = (permission) => permission === 'artifacts:read' || permission === 'artifacts:write';
  h.failProvider = false;
  invalidateArtifact(tpl);
  invalidateArtifact(tplDraft);
  invalidateArtifact(seg);
  invalidateArtifact(seg2);
  setWorkspaceTimeZone('UTC');
});

afterEach(() => {
  cleanup();
});

describe('composer checklist evidence (#497)', () => {
  it('template live is evidence only when the publication pointer exists', () => {
    expect(templateCheck({ templateId: undefined, loading: false, error: null }).status).toBe('not-checked');
    const notLive = templateCheck({
      templateId: tplDraft,
      loading: false,
      error: null,
      artifact: { name: 'Draft issue', publishedVersion: null },
    });
    expect(notLive.status).toBe('attention');
    expect(notLive.details.join(' ')).toMatch(/Not live/);
    const ready = templateCheck({
      templateId: tpl,
      loading: false,
      error: null,
      artifact: { name: 'Weekly Signal #43', publishedVersion: 5 },
    });
    expect(ready.status).toBe('ready');
    expect(ready.details).toEqual(['Weekly Signal #43 · Live v5']);
  });

  it('provider checks the stream boolean, not configured, and names the log adapter', () => {
    const input = {
      templateId: tpl,
      channel: 'email' as const,
      templateLoading: false,
      templateError: null,
      purposesLoading: false,
      purposesError: null,
      purpose: purpose('marketing_email'),
      status: systemStatus,
      statusLoading: false,
      statusError: null,
      canAdmin: true,
    };
    expect(providerCheck(input)).toMatchObject({ status: 'ready' });
    expect(
      providerCheck({ ...input, status: { ...systemStatus, emailProvider: { ...systemStatus.emailProvider, adapter: 'log' } } }),
    ).toMatchObject({
      status: 'attention',
    });
    expect(
      providerCheck({
        ...input,
        status: { ...systemStatus, emailProvider: { ...systemStatus.emailProvider, marketing: false } },
      }).details.join(' '),
    ).toContain('No marketing provider configured');
    expect(providerCheck({ ...input, channel: 'sms', purpose: purpose('marketing_sms') })).toMatchObject({
      status: 'not-applicable',
    });
    // A contract purpose reads transactional, even when marketing is configured.
    expect(
      providerCheck({
        ...input,
        purpose: purpose('onboarding'),
        status: { ...systemStatus, emailProvider: { ...systemStatus.emailProvider, marketing: false, transactional: true } },
      }),
    ).toMatchObject({ status: 'ready' });
  });

  it('sending domain shows every domain and never treats empty DKIM as proof', () => {
    const ready = domainCheck({
      templateId: tpl,
      channel: 'email',
      stream: 'marketing',
      data: withDomains([
        {
          ...sendingDomains.domains[0],
          dkim: [{ selector: 'ses', ok: true, record: 'p=abc' }],
        },
      ]),
      loading: false,
      error: null,
      canAdmin: true,
    });
    expect(ready.status).toBe('ready');
    expect(ready.details.join(' ')).toContain('mail.martechsignal.example');
    expect(ready.details.join(' ')).toContain('SPF found');
    expect(ready.details.join(' ')).toContain('DMARC found');
    expect(ready.details.join(' ')).toContain('checked');

    const unchecked = domainCheck({
      templateId: tpl,
      channel: 'email',
      stream: 'marketing',
      data: sendingDomains,
      loading: false,
      error: null,
      canAdmin: true,
    });
    expect(unchecked.status).toBe('not-checked');
    expect(unchecked.details.join(' ')).toMatch(/DKIM not checked — selectors required/);

    const failed = domainCheck({
      templateId: tpl,
      channel: 'email',
      stream: 'marketing',
      data: withDomains([{ ...sendingDomains.domains[0], spf: { ...sendingDomains.domains[0].spf, ok: false }, dkim: [] }]),
      loading: false,
      error: null,
      canAdmin: true,
    });
    expect(failed.status).toBe('attention');

    const none = domainCheck({
      templateId: tpl,
      channel: 'email',
      stream: 'transactional',
      data: sendingDomains,
      loading: false,
      error: null,
      canAdmin: false,
    });
    expect(none.status).toBe('attention');
    expect(none.details.join(' ')).toContain('No sending domain for transactional mail');
    expect(none.link).toBeUndefined();
    expect(
      domainCheck({ templateId: tpl, channel: 'sms', stream: null, data: undefined, loading: false, error: null, canAdmin: true }).status,
    ).toBe('not-applicable');
  });

  it('consent purpose validates the exact purpose, channel and effective topic without claiming consent', () => {
    const base = {
      templateId: tpl,
      channel: 'email' as const,
      templateLoading: false,
      templateError: null,
      purposes: purposes,
      purposesLoading: false,
      purposesError: null,
    };
    const ready = consentCheck({ ...base, templatePurpose: 'marketing_email', templateTopic: 'newsletter' });
    expect(ready.status).toBe('ready');
    expect(ready.details.join(' ')).toContain('Purpose configured · Marketing e-mail · consent');
    expect(ready.details.join(' ')).toContain('confirmed opt-in');
    expect(ready.details.join(' ')).toContain('Per-person consent');
    expect(ready.details.join(' ')).not.toMatch(/Audience consented/);

    expect(consentCheck({ ...base, templatePurpose: 'missing' }).status).toBe('attention');
    expect(consentCheck({ ...base, templatePurpose: 'marketing_sms' }).details.join(' ')).toContain('does not include the email channel');
    expect(consentCheck({ ...base, templatePurpose: 'marketing_email', broadcastTopic: 'product_news' }).details.join(' ')).toContain(
      'not under purpose',
    );
    // The broadcast topic overrides the template's topic.
    expect(
      consentCheck({ ...base, templatePurpose: 'marketing_email', templateTopic: 'newsletter', broadcastTopic: 'product_news' }).status,
    ).toBe('attention');
  });

  it('helper projections keep the stream rule, durations and days honest', () => {
    expect(channelOfTemplate(tpl)).toBe('email');
    expect(channelOfTemplate(`sms_${'a'.repeat(32)}`)).toBe('sms');
    expect(channelOfTemplate(undefined)).toBeNull();
    expect(streamOfBasis('contract')).toBe('transactional');
    expect(streamOfBasis('legal_obligation')).toBe('transactional');
    expect(streamOfBasis('consent')).toBe('marketing');
    expect(humanDuration('P1D')).toBe('1 day');
    expect(humanDuration('PT4H')).toBe('4 hours');
    expect(humanDuration('PT30M')).toBe('30 minutes');
    expect(daysLabel([])).toBe('every day');
    expect(daysLabel(['mon', 'tue'])).toBe('Monday, Tuesday');
    expect(windowSummary({ start: '09:00', end: '17:00', maxDelay: 'P1D' })).toBe(
      '09:00–17:00 in each reader’s time zone · every day · maximum wait 1 day',
    );
  });
});

describe('audience estimate wording (#497)', () => {
  it('reports the checked evidence and never extrapolates wouldSend', () => {
    const summary = estimateSummary(estimate);
    expect(summary.headline).toBe('1,842 eligible in current check');
    expect(summary.detail).toBe('Estimate · 2,000 of 12,480 members checked');
    expect(summary.skipped.map((s) => `${s.label}: ${s.count}`)).toEqual([
      'No consent for the purpose: 110',
      'Unsubscribed: 30',
      'Suppressed (bounced or complained): 18',
      'Over the frequency cap: 0',
    ]);
  });

  it('handles empty checks, zero eligible, a complete check and unknown reasons', () => {
    expect(estimateSummary({ ...estimate, checked: 0, wouldSend: 0 })).toMatchObject({ headline: 'No members checked' });
    expect(estimateSummary({ ...estimate, checked: 100, wouldSend: 0 })).toMatchObject({
      headline: 'No eligible recipients in this check',
    });
    expect(estimateSummary({ ...estimate, audience: 2000, checked: 2000 }).detail).toBe('Current check · all 2,000 members checked');
    expect(estimateSummary({ ...estimate, wouldSkip: { custom_reason: 2 } }).skipped).toEqual([
      { reason: 'custom_reason', label: 'custom reason', count: 2 },
    ]);
  });

  it('labels an unsaved draft against its base version and a clean render by its own version', () => {
    expect(previewSourceFor({ dirty: true, version: 4, publishedVersion: 4 })).toEqual({ kind: 'unsaved', baseVersion: 4 });
    expect(previewSourceFor({ dirty: false, version: 4, publishedVersion: 4 })).toEqual({ kind: 'published', version: 4 });
    expect(previewSourceFor({ dirty: false, version: 5, publishedVersion: 4 })).toEqual({ kind: 'saved', version: 5 });
  });
});

describe('composer component (#497)', () => {
  it('renders the four evidence rows, the estimate and the version-pinned e-mail', async () => {
    render(<Harness />);

    expect(await screen.findByText('1,842 eligible in current check')).toBeTruthy();
    const templateRow = screen.getByText('Template live').closest('[data-check]') as HTMLElement;
    const providerRow = screen.getByText('Provider').closest('[data-check]') as HTMLElement;
    const domainRow = screen.getByText('Sending domain').closest('[data-check]') as HTMLElement;
    const consentRow = screen.getByText('Consent purpose').closest('[data-check]') as HTMLElement;
    expect(templateRow.dataset.checkStatus).toBe('ready');
    await waitFor(() => expect(providerRow.dataset.checkStatus).toBe('ready'));
    expect(domainRow.dataset.checkStatus).toBe('not-checked');
    expect(within(domainRow).getAllByText(/DKIM not checked — selectors required/).length).toBeGreaterThan(0);
    await waitFor(() => expect(consentRow.dataset.checkStatus).toBe('ready'));
    expect(within(consentRow).getByText(/Per-person consent/)).toBeTruthy();

    expect(screen.getByText('Saved v4')).toBeTruthy();
    expect((await screen.findByText('Published v5')).closest('[data-preview-source]')?.textContent).toContain('template');
    expect(screen.getByText(/09:00–17:00 in each reader’s time zone/)).toBeTruthy();
  });

  it('requires a save before the audience estimate refreshes and never reads while dirty', async () => {
    render(<Harness />);
    expect(await screen.findByText('1,842 eligible in current check')).toBeTruthy();
    expect(calls('broadcasts.preview')).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/Segment/), { target: { value: seg2 } });

    expect(await screen.findByText('Save draft to refresh the audience estimate')).toBeTruthy();
    expect(screen.getByText('Unsaved draft')).toBeTruthy();
    expect(screen.getByText(/Previous check · Saved v4/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Refresh estimate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls('broadcasts.preview')).toHaveLength(1);
  });

  it('reads once on a clean composer, once after a save and once on an explicit refresh', async () => {
    const first = content();
    const firstArtifact = artifactFor(4, first);
    const { rerender } = render(
      <BroadcastEditor artifact={firstArtifact} content={first} onChange={() => {}} readOnly={false} errors={{}} warnings={[]} />,
    );
    expect(await screen.findByText('1,842 eligible in current check')).toBeTruthy();
    expect(calls('broadcasts.preview')).toHaveLength(1);
    expect(calls('broadcasts.preview')[0].input).toEqual({ artifactId: id, version: 4 });

    const saved = content({ description: 'Saved after review' });
    const nextArtifact = artifactFor(5, saved);
    rerender(<BroadcastEditor artifact={nextArtifact} content={saved} onChange={() => {}} readOnly={false} errors={{}} warnings={[]} />);
    await waitFor(() => expect(calls('broadcasts.preview')).toHaveLength(2));
    expect(calls('broadcasts.preview')[1].input).toEqual({ artifactId: id, version: 5 });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh estimate' }));
    await waitFor(() => expect(calls('broadcasts.preview')).toHaveLength(3));
    expect(calls('broadcasts.preview')[2].input).toEqual({ artifactId: id, version: 5 });
  });

  it('re-runs the estimate when a draft is saved in place at the same version', async () => {
    const first = content();
    const firstArtifact = artifactFor(4, first);
    const { rerender } = render(
      <BroadcastEditor artifact={firstArtifact} content={first} onChange={() => {}} readOnly={false} errors={{}} warnings={[]} />,
    );
    expect(await screen.findByText('1,842 eligible in current check')).toBeTruthy();
    expect(calls('broadcasts.preview')).toHaveLength(1);

    const saved = content({ description: 'Edited while still a draft' });
    const inPlace = {
      ...firstArtifact,
      version: { ...firstArtifact.version, contentHash: 'hash4-in-place', content: saved },
    };
    rerender(<BroadcastEditor artifact={inPlace} content={saved} onChange={() => {}} readOnly={false} errors={{}} warnings={[]} />);
    await waitFor(() => expect(calls('broadcasts.preview')).toHaveLength(2));
    expect(calls('broadcasts.preview')[1].input).toEqual({ artifactId: id, version: 4 });
  });

  it('uses exact reads: one selected template, one live version, and one provider/DNS/purpose read', async () => {
    render(<Harness />);
    expect(await screen.findByText('1,842 eligible in current check')).toBeTruthy();

    const gets = calls('artifacts.get');
    expect(gets).toHaveLength(3);
    expect(gets.map((call) => call.input)).toEqual(
      expect.arrayContaining([{ artifactId: tpl }, { artifactId: tpl, version: 5 }, { artifactId: seg }]),
    );
    expect(calls('system.status')).toHaveLength(1);
    expect(calls('sendingDomains.list')).toHaveLength(1);
    expect(calls('purposes.list')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh checks' }));
    await waitFor(() => expect(calls('system.status')).toHaveLength(2));
    expect(calls('sendingDomains.list')).toHaveLength(2);
    expect(calls('purposes.list')).toHaveLength(2);
    // Refreshing checks does not re-read the selected template, its live version or the segment.
    expect(calls('artifacts.get')).toHaveLength(3);
  });

  it('shows the save-required and empty states without inventing a number', async () => {
    render(<Harness initial={content({ segment: undefined })} />);
    expect(await screen.findByText('Choose a template and segment to check the audience.')).toBeTruthy();
    expect(screen.queryByText(/eligible in current check/)).toBeNull();
    expect(calls('broadcasts.preview')).toHaveLength(0);
  });

  it('keeps the composer readable but disabled for a read-only role', async () => {
    h.can = (permission) => permission === 'artifacts:read';
    render(<Harness readOnly />);

    expect(await screen.findByText('Your role can read this broadcast but cannot edit it.')).toBeTruthy();
    expect((screen.getByLabelText(/Template/) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Segment/) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Refresh checks' }) as HTMLButtonElement).disabled).toBe(false);
    expect(await screen.findByText('1,842 eligible in current check')).toBeTruthy();
  });

  it('never turns a failed provider read into ready and retries only that row', async () => {
    h.failProvider = true;
    render(<Harness />);
    const row = (await screen.findByText('Provider')).closest('[data-check]') as HTMLElement;
    const retry = await within(row).findByRole('button', { name: 'Retry' });
    expect(row.dataset.checkStatus).toBe('not-checked');
    expect(within(row).getByText('Provider status unavailable')).toBeTruthy();
    h.failProvider = false;
    fireEvent.click(retry);
    await waitFor(() => expect(row.dataset.checkStatus).toBe('ready'));
  });

  it('marks a draft template as not live and still checks its purpose', async () => {
    render(<Harness initial={content({ template: tplDraft })} />);
    const templateRow = (await screen.findByText('Template live')).closest('[data-check]') as HTMLElement;
    expect(templateRow.dataset.checkStatus).toBe('attention');
    expect(within(templateRow).getByText(/Not live/)).toBeTruthy();
    expect((await screen.findByText('Saved v2')).closest('[data-preview-source]')?.textContent).toContain('template · not live');
  });
});
