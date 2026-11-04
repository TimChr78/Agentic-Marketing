import { artifactTypes } from '@agentic-marketing/artifacts';
import { InboundEvent } from '@agentic-marketing/events';
import { describe, expect, it } from 'vitest';
import { defaultPolicy, processEvent, type SourceInfo, truncateIp, type WorkspacePolicy } from '../src/policy';

const browser: SourceInfo = { id: 'src_b', workspaceId: 'ws', kind: 'browser', requiredPurpose: 'analytics' };
const server: SourceInfo = { id: 'src_s', workspaceId: 'ws', kind: 'server', requiredPurpose: null };
const now = new Date('2026-10-22T10:00:00Z');
const run = (e: unknown, source = browser, policy: WorkspacePolicy = defaultPolicy) =>
  processEvent(InboundEvent.parse(e), source, policy, now, { ip: '203.0.113.77', messageId: () => 'generated' });
const yes = { consent: { categoryPreferences: { analytics: true } } };

const plan = artifactTypes.tracking_plan.content.parse({
  unknownEvents: 'warn',
  unknownProperties: 'block',
  events: [
    {
      name: 'Order Completed',
      properties: [
        { name: 'total', type: 'number', required: true },
        { name: 'shippingAddress', pii: true },
      ],
    },
  ],
  traits: [
    { name: 'loyaltyTier', pii: 'none' },
    { name: 'healthNotes', pii: 'sensitive' },
  ],
});

describe('consent gate', () => {
  it('drops browser events without a yes for the source purpose', () => {
    expect(run({ type: 'track', event: 'x', anonymousId: 'a' })).toEqual({ kind: 'dropped', reason: 'no_consent' });
    expect(
      run({ type: 'track', event: 'x', anonymousId: 'a', context: { consent: { categoryPreferences: { analytics: false } } } }).kind,
    ).toBe('dropped');
    expect(run({ type: 'track', event: 'x', anonymousId: 'a', context: yes }).kind).toBe('accepted');
  });

  it('always lets a consent change through, without its properties', () => {
    const out = run({
      type: 'track',
      event: 'Segment Consent Preference Updated',
      anonymousId: 'a',
      properties: { anything: 1 },
      context: { consent: { categoryPreferences: { analytics: false, marketing_email: false } } },
    });
    expect(out).toMatchObject({ kind: 'accepted', event: { properties: {}, consent: { analytics: false, marketing_email: false } } });
  });

  it('holds legitimate-interest purposes unless the visitor objected', () => {
    const li: WorkspacePolicy = {
      plan: null,
      purposes: [
        {
          key: 'analytics',
          name: 'A',
          description: '',
          basis: 'legitimate_interest',
          channels: [],
          requiresDoubleOptIn: false,
          topics: [],
        },
      ],
    };
    expect(run({ type: 'track', event: 'x', anonymousId: 'a' }, browser, li).kind).toBe('accepted');
    expect(
      run({ type: 'track', event: 'x', anonymousId: 'a', context: { consent: { categoryPreferences: { analytics: false } } } }, browser, li)
        .kind,
    ).toBe('dropped');
  });

  it('does not gate server sources without a required purpose', () => {
    expect(run({ type: 'track', event: 'x', userId: 'u1' }, server).kind).toBe('accepted');
  });
});

describe('personal data', () => {
  it('splits personal traits from the event and truncates IPs', () => {
    const out = run({ type: 'identify', userId: 'u1', traits: { email: 'a@example.com', plan: 'pro', firstName: 'Ada' }, context: yes });
    if (out.kind !== 'accepted') throw new Error(out.kind);
    expect(out.event.traits).toEqual({ plan: 'pro' });
    expect(out.event.piiTraits).toEqual({ email: 'a@example.com', firstName: 'Ada' });
    expect(out.event.context.ip).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::');
  });

  it('removes reserved personal properties without a plan, keeping non-personal metrics', () => {
    const out = run({
      type: 'track',
      event: 'Order Completed',
      userId: 'u1',
      properties: {
        total: 899,
        sku: 'TENT-2',
        email: 'buyer@example.com',
        name: 'Ada Lovelace',
        address: '1 Main Street',
        phone: '+4512345678',
        products: [{ name: 'Tent', price: 899 }],
      },
      context: yes,
    });
    expect(out).toMatchObject({ kind: 'accepted' });
    if (out.kind !== 'accepted') throw new Error(out.kind);
    expect(out.event.properties).toEqual({ total: 899, sku: 'TENT-2', products: [{ name: 'Tent', price: 899 }] });
  });

  it('removes top-level reserved keys from unlisted events, and keeps nested product metrics', () => {
    const p: WorkspacePolicy = { ...defaultPolicy, plan };
    const out = run(
      {
        type: 'track',
        event: 'Mystery',
        anonymousId: 'a',
        properties: { email: 'x@example.com', total: 1, products: [{ name: 'Tent', price: 20 }] },
        context: yes,
      },
      browser,
      p,
    );
    if (out.kind !== 'accepted') throw new Error(out.kind);
    expect(out.event.properties).toEqual({ total: 1, products: [{ name: 'Tent', price: 20 }] });
  });

  it('follows the attribute schema and removes PII properties, even when reserved', () => {
    const p: WorkspacePolicy = { ...defaultPolicy, plan };
    const id = run(
      { type: 'identify', userId: 'u1', traits: { loyaltyTier: 'gold', healthNotes: 'x', other: 1 }, context: yes },
      browser,
      p,
    );
    expect(id).toMatchObject({ event: { traits: { loyaltyTier: 'gold', other: 1 }, piiTraits: { healthNotes: 'x' } } });
    const order = run(
      { type: 'track', event: 'Order Completed', userId: 'u1', properties: { total: 99, shippingAddress: 'Street 1' }, context: yes },
      browser,
      p,
    );
    expect(order).toMatchObject({ kind: 'accepted', event: { properties: { total: 99 } } });
  });

  it('honors published non-personal classifications while removing declared PII', () => {
    const p: WorkspacePolicy = {
      ...defaultPolicy,
      plan: artifactTypes.tracking_plan.content.parse({
        unknownEvents: 'allow',
        events: [{ name: 'Order Completed', properties: [{ name: 'email', pii: true }, { name: 'name', pii: false }, { name: 'total' }] }],
      }),
    };
    const out = run(
      {
        type: 'track',
        event: 'Order Completed',
        anonymousId: 'a',
        properties: { email: 'x@example.com', name: 'Tent', total: 2 },
        context: yes,
      },
      browser,
      p,
    );
    if (out.kind !== 'accepted') throw new Error(out.kind);
    expect(out.event.properties).toEqual({ name: 'Tent', total: 2 });
  });
});

describe('tracking plan', () => {
  const p: WorkspacePolicy = { ...defaultPolicy, plan };
  it('warns on unknown events and blocks unknown properties or wrong types', () => {
    expect(run({ type: 'track', event: 'Mystery', anonymousId: 'a', context: yes }, browser, p)).toMatchObject({
      kind: 'accepted',
      warnings: ['Event "Mystery" is not in the tracking plan.'],
    });
    expect(
      run({ type: 'track', event: 'Order Completed', anonymousId: 'a', properties: { total: 1, coupon: 'X' }, context: yes }, browser, p),
    ).toMatchObject({
      kind: 'rejected',
    });
    expect(
      run({ type: 'track', event: 'Order Completed', anonymousId: 'a', properties: { total: '1' }, context: yes }, browser, p),
    ).toMatchObject({
      kind: 'rejected',
      error: expect.stringContaining('"total" should be number'),
    });
  });

  it('names events and corrects timestamps', () => {
    const out = run({ type: 'page', name: 'Home', anonymousId: 'a', timestamp: '2026-10-22T09:59:00Z', context: yes });
    expect(out).toMatchObject({ event: { name: 'Home', messageId: 'generated', timestamp: '2026-10-22T09:59:00.000Z' } });
  });
});
