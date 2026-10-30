import { newUuid } from '@agentic-marketing/core';
import type { BusEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// A segment entered/exited event is published by the platform about an existing person. If that
// person is erased while the event is still on the bus, processing it later must not create a new
// profile from their user id (found as a flaky warehouse export test: the erased person came back).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';

beforeAll(async () => {
  t = await startTestServer('test_erasure_in_flight', testPort(3477));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 60_000);
afterAll(() => t?.close());

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const systemEvent = (userId: string, profileId: string, name: string): BusEvent => {
  const now = new Date().toISOString();
  return {
    workspaceId: ws,
    sourceId: 'system',
    messageId: `seg:test:${profileId}:${name}:${newUuid()}`,
    type: 'track',
    name,
    anonymousId: '',
    userId,
    timestamp: now,
    receivedAt: now,
    properties: { segment_id: 'seg_test', profile_id: profileId },
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  };
};

describe('an erased person', () => {
  it('is not recreated by a segment event that was still in flight', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'gone', traits: { plan: 'pro' } }]);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'gone' }),
      (r) => !!r.profileId,
    );
    await api.call('profiles.erase', { profileId: profileId!, reason: 'Erasure request, test' });

    await t.srv.bus.publish([systemEvent('gone', profileId!, 'Segment Exited')]);
    // A later customer event proves the worker has processed the bus past the system event.
    await send([{ type: 'identify', userId: 'still-here', traits: { plan: 'free' } }]);
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'still-here' }),
      (r) => !!r.profileId,
    );
    expect((await api.call('profiles.find', { type: 'user_id', value: 'gone' })).profileId).toBeFalsy();
  });

  it('can still be recreated by their own new activity', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'gone', traits: { plan: 'free' } }]);
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'gone' }),
      (r) => !!r.profileId,
    );
  });
});
