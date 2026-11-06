import { beforeEach, describe, expect, it } from 'vitest';
import {
  BROADCAST_STATUS_FILTERS,
  type BroadcastListRow,
  broadcastAudienceOf,
  broadcastCountLabel,
  broadcastResultOf,
  broadcastScheduleOf,
  broadcastStateOf,
  broadcastSubtitleOf,
  filterForParam,
} from '../src/features/broadcasts/listView';
import { setWorkspaceTimeZone } from '../src/ui/time';

const AT = new Date('2026-11-06T10:20:00Z');

function run(overrides: Partial<BroadcastListRow['run']> = {}): BroadcastListRow['run'] {
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

function row(overrides: Partial<BroadcastListRow> = {}): BroadcastListRow {
  return {
    artifactId: `bct_${'a'.repeat(32)}`,
    name: 'Signal Weekly · issue 128',
    latestVersion: 3,
    latestState: 'published',
    publishedVersion: 3,
    updatedAt: '2026-11-06T09:00:00.000Z',
    run: run(),
    segmentId: `seg_${'b'.repeat(32)}`,
    templateId: `eml_${'c'.repeat(32)}`,
    stage: null,
    delivery: {},
    ...overrides,
  };
}

beforeEach(() => {
  setWorkspaceTimeZone('UTC');
});

describe('broadcast list rows (#448)', () => {
  it('scheduled: Scheduled, the send time, not started', () => {
    const r = row({ run: run({ status: 'scheduled', version: 3, sendAt: '2026-11-06T14:00:00Z', recipients: 10140, queued: 10000 }) });
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'scheduled', label: 'Scheduled' });
    expect(broadcastScheduleOf(r, AT).lines[0]).toContain('Nov 6, 2026');
    expect(broadcastResultOf(r).lines).toEqual(['Not started']);
    expect(broadcastAudienceOf(r, 'Engaged readers')).toEqual({ name: 'Engaged readers', detail: '10,140 reached at preparation' });
  });

  it('sending: Sending, started time, preparation queue and skips', () => {
    const r = row({
      run: run({
        status: 'running',
        version: 1,
        sendAt: '2026-11-06T10:00:00Z',
        startedAt: '2026-11-06T10:02:00Z',
        recipients: 8420,
        queued: 8420,
        skipped: 30,
        windowSkipped: 2,
      }),
    });
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'sending', label: 'Sending' });
    expect(broadcastScheduleOf(r, AT).lines).toEqual(['Started Nov 6, 2026, 10:02 AM UTC']);
    expect(broadcastResultOf(r).lines).toEqual(['8,420 queued during preparation', '30 skipped', '2 outside the send window']);
  });

  it('delivering: a done run with provider backlog', () => {
    const r = row({
      run: run({
        status: 'done',
        version: 2,
        sendAt: '2026-11-05T16:00:00Z',
        finishedAt: '2026-11-05T16:12:00Z',
        recipients: 10140,
        queued: 10000,
      }),
      delivery: { sent: 6000, delivered: 3860, queued: 140 },
    });
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'delivering', label: 'Delivering' });
    expect(broadcastScheduleOf(r, AT).lines).toEqual(['Finished Nov 5, 2026, 04:12 PM UTC']);
    expect(broadcastResultOf(r).lines).toEqual(['9,860 provider-accepted', '140 awaiting provider']);
  });

  it('sent: provider-accepted, no fabricated delivered total', () => {
    const r = row({ run: run({ status: 'done', version: 1, recipients: 100 }), delivery: { delivered: 100 } });
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'sent', label: 'Sent' });
    expect(broadcastResultOf(r).lines).toEqual(['100 provider-accepted']);
  });

  it('sent with failures: warns and keeps failures separate', () => {
    const r = row({ run: run({ status: 'done', version: 1, recipients: 100 }), delivery: { delivered: 98, failed: 2 } });
    const state = broadcastStateOf(r, AT);
    expect(state).toMatchObject({ key: 'sent', label: 'Sent', tone: 'warn' });
    expect(broadcastResultOf(r).lines).toEqual(['98 provider-accepted', '2 failed']);
  });

  it('stopped: stopped with cumulative preparation and the safe reason', () => {
    const r = row({
      run: run({ status: 'stopped', version: 2, recipients: 620, queued: 620, startedAt: '2026-11-04T09:00:00Z' }),
      stage: { stage: 'stopped', stopReason: 'The canary bounced 8% of its sends.' },
      delivery: { delivered: 300 },
    });
    const state = broadcastStateOf(r, AT);
    expect(state).toMatchObject({ key: 'stopped', label: 'Stopped' });
    expect(broadcastResultOf(r).lines).toEqual(['620 queued during preparation', 'The canary bounced 8% of its sends.']);
    expect(broadcastScheduleOf(r, AT).lines[0]).toContain('Started');
  });

  it('nothing sent: suppressed messages are not a zero-sent claim', () => {
    const r = row({ run: run({ status: 'done', version: 1, recipients: 100 }), delivery: { suppressed: 100 } });
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'suppressed', label: 'Nothing sent' });
    expect(broadcastResultOf(r).lines).toEqual(['100 suppressed']);
  });

  it('not scheduled: Published, not scheduled and eligibility on review', () => {
    const r = row({ run: run({ status: 'not_scheduled' }), latestState: 'published', publishedVersion: 3 });
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'published', label: 'Published' });
    expect(broadcastScheduleOf(r, AT).lines).toEqual(['Not scheduled']);
    expect(broadcastResultOf(r).lines).toEqual(['Not started']);
    expect(broadcastAudienceOf(r, 'Engaged readers').detail).toBe('Eligibility checked on review');
  });

  it('not scheduled draft: Draft, never a publication-derived send claim', () => {
    const r = row({ run: run({ status: 'not_scheduled' }), latestState: 'draft', publishedVersion: null, latestVersion: 1 });
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'draft', label: 'Draft' });
  });

  it('shows a newer draft without overwriting the runtime state', () => {
    const r = row({
      latestVersion: 2,
      latestState: 'draft',
      run: run({ status: 'running', version: 1, recipients: 10, queued: 10 }),
    });
    expect(broadcastSubtitleOf(r)).toBe('Sending v1 · draft v2');
    expect(broadcastStateOf(r, AT)).toMatchObject({ key: 'sending' });
    expect(broadcastSubtitleOf(row({ latestVersion: 2, latestState: 'in_review', run: run({ status: 'done', version: 1 }) }))).toBe(
      'v2 in review',
    );
  });

  it('labels counts and filters exactly as the contract fixes them', () => {
    expect(broadcastCountLabel(1)).toBe('1 broadcast');
    expect(broadcastCountLabel(47)).toBe('47 broadcasts');
    expect(BROADCAST_STATUS_FILTERS.map((f) => f.label)).toEqual([
      'All statuses',
      'Scheduled and sending',
      'Scheduled',
      'Sending',
      'Finished preparation',
      'Stopped',
      'Failed',
      'Cancelled',
      'Not scheduled',
    ]);
    expect(filterForParam('active').filter.statuses).toEqual(['scheduled', 'running']);
    expect(filterForParam('not_scheduled').filter.statuses).toEqual(['not_scheduled']);
    expect(filterForParam('wat')).toMatchObject({ unknown: true, filter: { key: 'all' } });
  });
});
