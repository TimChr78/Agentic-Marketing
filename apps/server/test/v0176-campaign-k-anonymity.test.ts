import type { MessageEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #1147: `memberBreakdown.reached` must count people actually sent/delivered to, not every
// queued/suppressed/failed attempt. A member below k real sends stays hidden even when many
// suppressed rows would otherwise push it over the k-anonymity gate.

const PORT = testPort(3499);
const DB = 'test_v0176_campaign_kanon';
const FROM = '2026-05-01T00:00:00.000Z';
const TO = '2026-05-31T00:00:00.000Z';
const AT = '2026-05-10T10:00:00.000Z';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const stamp = Date.now();
const api = () => t.api(owner, ws);

let profile = 0;
const person = () => `prf_${(++profile).toString(16).padStart(32, '0')}`;

const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

function messageEvents(memberId: string, type: MessageEvent['type'], people: string[]): MessageEvent[] {
  return people.map((profileId, i) => ({
    workspaceId: ws,
    messageId: `msg_${memberId}_${type}_${i}`,
    eventId: `${memberId}:${type}:${i}`,
    type,
    at: AT,
    profileId,
    channel: 'email',
    purpose: 'marketing_email',
    provider: 'log',
    templateId: '',
    templateVersion: 1,
    journeyId: memberId,
    variant: '',
    reason: '',
    url: '',
  }));
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT);
  owner = await t.signUp(`owner-kanon-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('campaign summary k-anonymity (#1147)', () => {
  it('keeps a member with fewer than k real sends hidden despite many suppressed attempts', async () => {
    const template = (
      await api().call('artifacts.create', {
        type: 'email_template',
        name: 'K-anonymity issue',
        content: { purpose: 'marketing_email', subject: 'The issue', mjml },
      })
    ).artifactId;
    const segment = (
      await api().call('artifacts.create', {
        type: 'segment',
        name: 'Everyone with consent',
        content: { condition: { consent: 'marketing_email' } },
      })
    ).artifactId;
    await api().call('artifacts.requestPublishBundle', { artifactIds: [template, segment], note: 'prerequisites' });

    const broadcast = (await api().call('artifacts.create', { type: 'broadcast', name: 'Small broadcast', content: { template, segment } }))
      .artifactId;

    const campaign = (
      await api().call('artifacts.create', {
        type: 'campaign',
        name: 'Small campaign',
        content: {
          startsAt: '2026-04-30T00:00:00.000Z',
          goal: { kind: 'conversion', event: 'Order Completed', attributionDays: 7 },
          members: [{ artifactId: broadcast, role: 'primary' }],
        },
      })
    ).artifactId;
    await api().call('artifacts.requestPublishBundle', { artifactIds: [broadcast, campaign], note: 'broadcast and campaign' });

    // Three real sends and four suppressed attempts, all to distinct people: the old `reached`
    // counted seven, which is over k=5 and exposed the small group.
    const sent = Array.from({ length: 3 }, person);
    const suppressed = Array.from({ length: 4 }, person);
    await t.srv.events.insertMessageEvents([
      ...messageEvents(broadcast, 'sent', sent),
      ...messageEvents(broadcast, 'suppressed', suppressed),
    ]);

    const summary = (await api().call('analytics.campaignSummary', { campaignId: campaign, from: FROM, to: TO })) as {
      state: string;
      members: { artifactId: string; suppressed: boolean; sent: number | null; delivered: number | null }[];
    };
    expect(summary.state).toBe('measured');
    const member = summary.members.find((m) => m.artifactId === broadcast);
    expect(member).toBeDefined();
    expect(member!.suppressed).toBe(true);
    expect(member!.sent).toBeNull();
    expect(member!.delivered).toBeNull();
  }, 120_000);
});
