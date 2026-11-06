import { describe, expect, it } from 'vitest';
import {
  publicationLabel,
  stateOfAgent,
  stateOfArtifact,
  stateOfBroadcast,
  stateOfExperience,
  stateOfForm,
  stateOfJourney,
} from '../src/lib/state';

const NOW = new Date('2026-11-06T09:00:00.000Z');

const artifact = (latestState: string, publishedVersion: number | null = null) => ({
  type: 'broadcast',
  latestState,
  latestVersion: latestState === 'published' ? 2 : 3,
  publishedVersion,
});

describe('broadcast operational state (#437)', () => {
  it('maps the publication-only states', () => {
    expect(stateOfBroadcast({ ...artifact('draft'), now: NOW })).toMatchObject({
      key: 'draft',
      label: 'Draft',
      tone: 'neutral',
      icon: 'dot',
    });
    expect(stateOfBroadcast({ ...artifact('in_review'), now: NOW })).toMatchObject({
      key: 'in_review',
      label: 'In review',
      tone: 'warn',
      icon: 'clock',
    });
    expect(stateOfBroadcast({ ...artifact('rejected'), now: NOW })).toMatchObject({
      key: 'rejected',
      label: 'Rejected',
      tone: 'bad',
      icon: 'octagon',
    });
  });

  it('shows a published broadcast with no run read as published, not sent', () => {
    expect(stateOfBroadcast({ ...artifact('published', 2), now: NOW })).toMatchObject({
      key: 'published',
      label: 'Published',
      tone: 'good',
      icon: 'check',
    });
  });

  it('keeps a live broadcast published and names its unpublished changes', () => {
    const state = stateOfBroadcast({ ...artifact('draft', 2), now: NOW });
    expect(state).toMatchObject({ key: 'published', label: 'Published', tone: 'good', detail: 'Unpublished changes' });
  });

  it('maps scheduled, sending, sent, cancelled, stopped and blocked runs', () => {
    const run = (status: 'scheduled' | 'running' | 'done' | 'cancelled' | 'stopped' | 'failed', extra = {}) =>
      stateOfBroadcast({ ...artifact('published', 2), run: { status, ...extra }, now: NOW });

    expect(run('scheduled', { sendAt: '2026-11-16T09:00:00.000Z' })).toMatchObject({
      key: 'scheduled',
      label: 'Scheduled',
      tone: 'info',
      icon: 'clock',
    });
    expect(run('running')).toMatchObject({ key: 'sending', label: 'Sending', tone: 'info', icon: 'arrow' });
    // Without message counts a finished run only proves the messages were queued (#442 review).
    expect(run('done')).toMatchObject({ key: 'queued', label: 'Queued', tone: 'info' });
    expect(run('done', {})).toMatchObject({ key: 'queued' });
    expect(run('cancelled')).toMatchObject({ key: 'cancelled', label: 'Cancelled', tone: 'neutral', icon: 'square' });
    expect(run('stopped', { error: 'The provider refused the run.' })).toMatchObject({
      key: 'stopped',
      label: 'Stopped',
      tone: 'bad',
      icon: 'octagon',
      detail: 'The provider refused the run.',
    });
    expect(run('failed', { error: 'Template missing.' })).toMatchObject({
      key: 'blocked',
      label: 'Blocked',
      tone: 'bad',
      icon: 'octagon',
      detail: 'Template missing.',
    });
  });

  it('does not claim sent when a scheduled time has passed but the run has not started', () => {
    const state = stateOfBroadcast({
      ...artifact('published', 2),
      run: { status: 'scheduled', sendAt: '2026-11-05T09:00:00.000Z' },
      now: NOW,
    });
    expect(state.key).toBe('scheduled');
    expect(state.label).toBe('Scheduled');
    expect(state.detail).toMatch(/send time has passed/i);
  });

  it('names the canary reason on a stopped staged send', () => {
    const state = stateOfBroadcast({
      ...artifact('published', 2),
      run: { status: 'stopped' },
      stage: { stage: 'stopped', stopReason: 'complaint rate 2.2% over the canary (stop at 0.3%)' },
      now: NOW,
    });
    expect(state).toMatchObject({
      key: 'stopped',
      label: 'Stopped',
      tone: 'bad',
      detail: 'complaint rate 2.2% over the canary (stop at 0.3%)',
    });
  });
});

describe('journey, experience and form operational states (#437)', () => {
  const journey = (latestState: string, publishedVersion: number | null = null) => ({
    type: 'journey',
    latestState,
    publishedVersion,
  });

  it('maps draft, in review, live, paused and stopped', () => {
    expect(stateOfJourney(journey('draft'))).toMatchObject({ key: 'draft', label: 'Draft', tone: 'neutral', icon: 'dot' });
    expect(stateOfJourney(journey('in_review'))).toMatchObject({ key: 'in_review', tone: 'warn', icon: 'clock' });
    expect(stateOfJourney(journey('published', 4))).toMatchObject({ key: 'live', label: 'Live', tone: 'good', icon: 'check' });
    expect(stateOfJourney({ ...journey('published', 4), paused: true })).toMatchObject({
      key: 'paused',
      label: 'Paused',
      tone: 'neutral',
      icon: 'pause',
    });
    expect(stateOfJourney({ ...journey('published', 4), stopped: true })).toMatchObject({
      key: 'stopped',
      label: 'Stopped',
      tone: 'neutral',
      icon: 'square',
    });
  });

  it('keeps a live journey live while a new draft waits', () => {
    expect(stateOfJourney(journey('draft', 4))).toMatchObject({ key: 'live', label: 'Live', detail: 'Unpublished changes' });
  });

  it('keeps a live artifact live while a replacement is in review or was rejected', () => {
    expect(stateOfJourney(journey('in_review', 4))).toMatchObject({ key: 'live', label: 'Live', tone: 'good' });
    expect(stateOfJourney(journey('in_review', 4)).detail).toMatch(/v4 stays live/i);
    expect(stateOfJourney(journey('rejected', 4))).toMatchObject({ key: 'live', label: 'Live' });
    expect(stateOfJourney(journey('rejected', 4)).detail).toMatch(/rejected; v4 is still live/i);
    // Never published: the review state is the state.
    expect(stateOfJourney(journey('in_review', null))).toMatchObject({ key: 'in_review', label: 'In review' });
    expect(stateOfJourney(journey('rejected', null))).toMatchObject({ key: 'rejected', label: 'Rejected' });
  });

  it('says sent only when providers accepted messages, and delivering while some wait', () => {
    // `delivery` holds each message's current status, so the counts add up to the messages.
    const done = (delivery: Record<string, number>) =>
      stateOfBroadcast({ ...artifact('published', 2), run: { status: 'done' }, delivery, now: NOW });
    expect(done({ queued: 5, sent: 95 })).toMatchObject({ key: 'delivering', label: 'Delivering' });
    expect(done({ sent: 40, delivered: 60 })).toMatchObject({ key: 'sent', label: 'Sent', tone: 'good' });
    expect(done({ delivered: 90, failed: 10 })).toMatchObject({ key: 'sent', tone: 'warn' });
    expect(done({ delivered: 70, suppressed: 30 })).toMatchObject({ key: 'sent', tone: 'good' });
    expect(done({ failed: 3 })).toMatchObject({ key: 'failed', label: 'Failed', tone: 'bad' });
    expect(done({ suppressed: 12 })).toMatchObject({ key: 'suppressed', label: 'Nothing sent' });
    expect(done({})).toMatchObject({ key: 'sent_none', label: 'Nobody to send to' });
  });

  it('maps experiences and forms, including a paused one', () => {
    expect(stateOfExperience({ type: 'experience', latestState: 'published', publishedVersion: 1 })).toMatchObject({
      key: 'live',
      label: 'Live',
    });
    expect(stateOfExperience({ type: 'experience', latestState: 'draft', publishedVersion: 1 })).toMatchObject({
      detail: 'Unpublished changes',
    });
    expect(stateOfExperience({ type: 'experience', latestState: 'published', publishedVersion: 1, paused: true })).toMatchObject({
      key: 'paused',
      icon: 'pause',
    });
    expect(stateOfForm({ type: 'form', latestState: 'in_review', publishedVersion: null })).toMatchObject({
      key: 'in_review',
      tone: 'warn',
    });
    expect(stateOfForm({ type: 'form', latestState: 'published', publishedVersion: 2 })).toMatchObject({
      key: 'live',
      label: 'Live',
    });
  });
});

describe('agent operational state (#437)', () => {
  it('maps active, paused, held by the guardian and revoked', () => {
    expect(stateOfAgent({ status: 'active' })).toMatchObject({ key: 'active', label: 'Active', tone: 'good', icon: 'check' });
    expect(stateOfAgent({ status: 'paused', statusReason: 'Investigating a loop' })).toMatchObject({
      key: 'paused',
      label: 'Paused',
      tone: 'neutral',
      icon: 'pause',
      detail: 'Investigating a loop',
    });
    expect(stateOfAgent({ status: 'active', guard: { cap: 1, reason: 'Send volume spiked' } })).toMatchObject({
      key: 'held',
      label: 'Held',
      tone: 'warn',
      icon: 'hand',
      detail: 'Send volume spiked',
    });
    expect(stateOfAgent({ status: 'revoked', statusReason: 'Owner request' })).toMatchObject({
      key: 'revoked',
      label: 'Revoked',
      tone: 'bad',
      icon: 'octagon',
    });
  });

  it('prefers paused over a guardian cap and never invents a green state', () => {
    expect(stateOfAgent({ status: 'paused', guard: { cap: 1 } }).key).toBe('paused');
    expect(stateOfAgent({ status: 'retired' })).toMatchObject({ key: 'unknown', label: 'Unknown state', tone: 'neutral' });
  });
});

describe('artifact dispatcher and publication metadata (#437)', () => {
  it('dispatches each family to its own state model', () => {
    expect(stateOfArtifact({ type: 'journey', latestState: 'published', publishedVersion: 2 }).key).toBe('live');
    expect(stateOfArtifact({ type: 'form', latestState: 'published', publishedVersion: 2 }).key).toBe('live');
    expect(stateOfArtifact({ type: 'broadcast', latestState: 'draft', publishedVersion: null }).key).toBe('draft');
    expect(stateOfArtifact({ type: 'email_template', latestState: 'published', publishedVersion: 2 }).key).toBe('published');
  });

  it('turns the publication version into secondary text', () => {
    expect(publicationLabel({ publishedVersion: 2 })).toBe('Published v2');
    expect(publicationLabel({ latestVersion: 3, publishedVersion: null })).toBe('v3 · not published');
    expect(publicationLabel({ publishedVersion: null })).toBe('Not published');
  });
});
