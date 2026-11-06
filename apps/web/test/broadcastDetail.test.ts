import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BroadcastDetailArtifact,
  type BroadcastRun,
  broadcastConsequenceOf,
  broadcastDetailStateOf,
  broadcastPrimaryActionOf,
  defaultBroadcastTab,
  isBroadcastTab,
} from '../src/features/broadcasts/detailView';
import { setWorkspaceTimeZone } from '../src/ui/time';

const AT = new Date('2026-11-06T10:20:00Z');

function artifact(overrides: Partial<BroadcastDetailArtifact> = {}): BroadcastDetailArtifact {
  return {
    id: `bct_${'a'.repeat(32)}`,
    type: 'broadcast',
    name: 'Lifecycle playbook',
    latestVersion: 2,
    publishedVersion: 2,
    version: {
      number: 2,
      state: 'published',
      author: { type: 'user', id: 'person_1', client: null },
      by: {
        kind: 'person',
        displayName: 'Alex Morgan',
        personName: 'Alex Morgan',
        tokenName: null,
        tokenId: null,
        clientName: null,
      },
      note: null,
      contentHash: 'hash',
      basedOn: 1,
      createdAt: '2026-11-05T15:20:00Z',
      content: {
        template: `eml_${'c'.repeat(32)}`,
        segment: `seg_${'b'.repeat(32)}`,
        sendAt: '2026-11-05T16:00:00Z',
      },
    },
    layout: null,
    references: [`eml_${'c'.repeat(32)}`, `seg_${'b'.repeat(32)}`],
    ...overrides,
  };
}

function run(overrides: Partial<BroadcastRun> = {}): BroadcastRun {
  return {
    status: 'not_scheduled',
    version: null,
    sendAt: null,
    recipients: 0,
    queued: 0,
    skipped: 0,
    windowSkipped: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

const base = {
  artifact: artifact(),
  segmentName: 'Lifecycle readers',
  now: AT,
};

beforeEach(() => {
  setWorkspaceTimeZone('UTC');
});

describe('broadcast detail summary (#448)', () => {
  it('scheduled: who reached at preparation, the send time, and the start', () => {
    const lines = broadcastConsequenceOf({
      ...base,
      run: run({ status: 'scheduled', version: 2, sendAt: '2026-11-06T14:00:00Z', recipients: 10140 }),
      delivery: { queued: 10000 },
    });
    expect(lines.who).toBe('Lifecycle readers · 10,140 reached at preparation');
    expect(lines.when).toBe('Nov 6, 2026, 02:00 PM UTC');
    expect(lines.next).toBe('Starts Nov 6, 2026, 02:00 PM UTC.');
  });

  it('run v1 pinned to segment A: Who uses A while the v2 draft targeting B is labelled separately', () => {
    const lines = broadcastConsequenceOf({
      ...base,
      artifact: artifact({ latestVersion: 2, publishedVersion: 1 }),
      run: run({ status: 'scheduled', version: 1, sendAt: '2026-11-06T14:00:00Z', recipients: 500 }),
      segmentName: 'Segment B',
      draftSegmentName: 'Segment B',
      runSegmentName: 'Segment A',
      draftTemplateName: 'Field notes',
    });
    expect(lines.who).toBe('Segment A · 500 reached at preparation');
    expect(lines.draft).toBe('Draft v2 targets Segment B · Field notes');
  });

  it('scheduled overdue: says the time passed instead of a missed failure', () => {
    const lines = broadcastConsequenceOf({
      ...base,
      run: run({ status: 'scheduled', version: 2, sendAt: '2026-11-05T14:00:00Z', recipients: 10 }),
    });
    expect(lines.next).toBe('Send time passed; waiting to start.');
  });

  it('delivering: the provider backlog is the next step', () => {
    const lines = broadcastConsequenceOf({
      ...base,
      run: run({ status: 'done', version: 2, sendAt: '2026-11-05T16:00:00Z', recipients: 10140 }),
      delivery: { sent: 9860, queued: 140 },
    });
    expect(lines.next).toBe('140 messages still waiting for the provider. Inspect sending progress.');
  });

  it('stopped: the canary reason is in the summary, not only in context', () => {
    const lines = broadcastConsequenceOf({
      ...base,
      artifact: artifact({ publishedVersion: 1 }),
      run: run({ status: 'stopped', version: 1, sendAt: '2026-11-04T09:00:00Z', recipients: 620, error: 'Canary stopped' }),
      stage: { stage: 'stopped', stopReason: 'The canary bounced 8% of its sends.' },
    });
    expect(lines.next).toBe('The canary bounced 8% of its sends. Review the canary before sending the rest.');
  });

  it('not scheduled with saved content uses the saved schedule', () => {
    const lines = broadcastConsequenceOf({ ...base });
    expect(lines.when).toBe('Saved schedule: Nov 5, 2026, 04:00 PM UTC');
    expect(lines.who).toBe('Lifecycle readers · Eligibility not checked');
  });

  it('dirty content is labelled unsaved and never presented as the live schedule', () => {
    const lines = broadcastConsequenceOf({
      ...base,
      dirty: true,
      draft: { template: null, segment: null, sendAt: '2026-11-09T09:00:00Z' },
    });
    expect(lines.when).toBe('Unsaved draft · Nov 9, 2026, 09:00 AM UTC');
  });

  it('no time at all is on publication', () => {
    const saved = artifact();
    saved.version.content = { template: null, segment: null };
    const lines = broadcastConsequenceOf({ ...base, artifact: saved });
    expect(lines.when).toBe('On publication');
  });

  it('status unavailable keeps saved content and asks for a status retry', () => {
    const lines = broadcastConsequenceOf({ ...base, statusError: 'network' });
    expect(lines.next).toBe('Retry sending status to inspect progress.');
    expect(broadcastDetailStateOf({ ...base, statusError: 'network' })).toMatchObject({
      key: 'unknown',
      label: 'Send state unavailable',
    });
  });
});

describe('broadcast primary action (#448)', () => {
  const action = (overrides: Partial<Parameters<typeof broadcastPrimaryActionOf>[0]> = {}) =>
    broadcastPrimaryActionOf({ artifact: artifact(), ...overrides });

  it('runtime state wins before the draft state', () => {
    expect(action({ run: run({ status: 'scheduled' }) })).toMatchObject({ kind: 'tab', tab: 'sending', label: 'View sending' });
    expect(action({ run: run({ status: 'running' }) })).toMatchObject({ kind: 'tab', tab: 'sending', label: 'View sending' });
    expect(action({ run: run({ status: 'stopped' }) })).toMatchObject({ kind: 'tab', tab: 'sending', label: 'Inspect canary' });
    expect(action({ run: run({ status: 'failed' }) })).toMatchObject({ kind: 'tab', tab: 'sending', label: 'Inspect failure' });
    expect(action({ run: run({ status: 'done' }) })).toMatchObject({ kind: 'tab', tab: 'report', label: 'View report' });
    expect(action({ run: run({ status: 'cancelled' }) })).toMatchObject({ kind: 'tab', tab: 'report', label: 'View report' });
    // A dirty draft does not displace the runtime inspection action.
    expect(action({ run: run({ status: 'scheduled' }), dirty: true })).toMatchObject({ kind: 'tab', tab: 'sending' });
  });

  it('a draft with no run saves while dirty, then submits or publishes', () => {
    const draft = artifact({ publishedVersion: null, latestVersion: 3, version: { ...artifact().version, state: 'draft', number: 3 } });
    expect(broadcastPrimaryActionOf({ artifact: draft, dirty: true })).toEqual({ kind: 'save', label: 'Save draft' });
    expect(broadcastPrimaryActionOf({ artifact: draft, canSubmit: true })).toEqual({ kind: 'publish', label: 'Submit for review' });
    expect(broadcastPrimaryActionOf({ artifact: draft, canSubmit: true, directPublish: true })).toEqual({
      kind: 'publish',
      label: 'Publish v3',
    });
    expect(broadcastPrimaryActionOf({ artifact: draft, readOnly: true })).toEqual({ kind: 'tab', tab: 'content', label: 'View content' });
  });

  it('rejected content can be submitted again', () => {
    const rejected = artifact({
      publishedVersion: null,
      version: { ...artifact().version, state: 'rejected' },
    });
    expect(broadcastPrimaryActionOf({ artifact: rejected, canSubmit: true })).toMatchObject({ kind: 'publish' });
  });

  it('in review links the request to the reviewer or the activity history', () => {
    const review = artifact({ publishedVersion: null, version: { ...artifact().version, state: 'in_review' } });
    expect(broadcastPrimaryActionOf({ artifact: review, pendingId: 'apr_1', canApprove: true })).toEqual({
      kind: 'link',
      to: '/approvals/apr_1',
      label: 'Review request',
    });
    expect(broadcastPrimaryActionOf({ artifact: review, pendingId: 'apr_1' })).toEqual({
      kind: 'link',
      to: '/approvals/apr_1',
      label: 'View request',
    });
    expect(broadcastPrimaryActionOf({ artifact: review })).toEqual({ kind: 'tab', tab: 'activity', label: 'View activity' });
  });

  it('published and not scheduled inspects sending; status failure retries status', () => {
    expect(action()).toEqual({ kind: 'tab', tab: 'sending', label: 'View sending' });
    expect(action({ statusError: 'boom' })).toEqual({ kind: 'retry', label: 'Retry status' });
  });
});

describe('broadcast detail tabs (#448)', () => {
  it('defaults from the runtime state and only accepts the contract tabs', () => {
    expect(defaultBroadcastTab(undefined)).toBe('content');
    expect(defaultBroadcastTab({ run: run({ status: 'scheduled' }) } as never)).toBe('sending');
    expect(defaultBroadcastTab({ run: run({ status: 'running' }) } as never)).toBe('sending');
    expect(defaultBroadcastTab({ run: run({ status: 'stopped' }) } as never)).toBe('sending');
    expect(defaultBroadcastTab({ run: run({ status: 'failed' }) } as never)).toBe('sending');
    expect(defaultBroadcastTab({ run: run({ status: 'done' }) } as never)).toBe('report');
    expect(defaultBroadcastTab({ run: run({ status: 'cancelled' }) } as never)).toBe('report');
    expect(isBroadcastTab('sending')).toBe(true);
    expect(isBroadcastTab('nope')).toBe(false);
  });
});
