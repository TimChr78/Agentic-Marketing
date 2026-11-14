import { artifactTypes } from '@agentic-marketing/artifacts';
import { InboundEvent } from '@agentic-marketing/events';
import { describe, expect, it } from 'vitest';
import { acceptInternalItems, acceptItems } from '../src/gateway';
import { defaultPolicy, PLATFORM_EVENTS, processEvent, type SourceInfo, truncateIp, type WorkspacePolicy } from '../src/policy';

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
  it('warns on unknown events, blocks unknown properties, and warns about declared wrong types', () => {
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
      error: '"Order Completed": "total" should be number',
    });
  });

  it('names events and corrects timestamps', () => {
    const out = run({ type: 'page', name: 'Home', anonymousId: 'a', timestamp: '2026-10-22T09:59:00Z', context: yes });
    expect(out).toMatchObject({ event: { name: 'Home', messageId: 'generated', timestamp: '2026-10-22T09:59:00.000Z' } });
  });
});

// #623: declared `required` / `type` problems have their own `declaredProperties` setting. When a
// plan predates it, the setting is derived from `unknownProperties` so existing strict plans keep
// rejecting; `unknownEvents` never influences it.
describe('declared property validation', () => {
  type Settings = {
    unknownEvents?: 'allow' | 'warn' | 'block';
    unknownProperties?: 'allow' | 'warn' | 'block';
    declaredProperties?: 'warn' | 'block';
  };
  const declared = (settings: Settings): WorkspacePolicy => ({
    ...defaultPolicy,
    plan: artifactTypes.tracking_plan.content.parse({
      unknownEvents: 'allow',
      unknownProperties: 'allow',
      ...settings,
      events: [{ name: 'Purchase', properties: [{ name: 'amount', type: 'number', required: true }] }],
    }),
  });
  const outcome = (settings: Settings, properties: Record<string, unknown>) =>
    processEvent(
      InboundEvent.parse({ type: 'track', event: 'Purchase', anonymousId: 'a', properties, context: yes }),
      browser,
      declared(settings),
      now,
      { messageId: () => 'generated' },
    );

  it('derives block from unknownProperties: block when the setting is absent', () => {
    expect(outcome({ unknownProperties: 'block' }, { amount: 'free' })).toMatchObject({
      kind: 'rejected',
      error: '"Purchase": "amount" should be number',
    });
    expect(outcome({ unknownProperties: 'block' }, {})).toMatchObject({
      kind: 'rejected',
      error: '"Purchase": "amount" is required',
    });
  });

  it('does not derive from unknownEvents when the setting is absent', () => {
    expect(outcome({ unknownEvents: 'block', unknownProperties: 'allow' }, { amount: 'free' })).toMatchObject({
      kind: 'accepted',
      warnings: ['"Purchase": "amount" should be number'],
    });
    expect(outcome({ unknownEvents: 'block', unknownProperties: 'allow' }, {})).toMatchObject({
      kind: 'accepted',
      warnings: ['"Purchase": "amount" is required'],
    });
  });

  it('lets an explicit warn override unknownProperties: block', () => {
    expect(outcome({ unknownProperties: 'block', declaredProperties: 'warn' }, { amount: 'free' })).toMatchObject({
      kind: 'accepted',
      warnings: ['"Purchase": "amount" should be number'],
    });
  });

  it('lets an explicit block apply while the unknown settings allow', () => {
    expect(outcome({ unknownEvents: 'allow', unknownProperties: 'allow', declaredProperties: 'block' }, { amount: 'free' })).toMatchObject({
      kind: 'rejected',
      error: '"Purchase": "amount" should be number',
    });
    expect(outcome({ unknownEvents: 'allow', unknownProperties: 'allow', declaredProperties: 'block' }, {})).toMatchObject({
      kind: 'rejected',
      error: '"Purchase": "amount" is required',
    });
  });
});

// #624: the platform emits its own carrier events (signup, confirmation, import, e-mail outcomes)
// through the same ingest path. A workspace's product-analytics plan must never reject them, but
// only the platform's own server-side callers may use the exemption.
describe('platform-owned events', () => {
  const strict: WorkspacePolicy = {
    ...defaultPolicy,
    plan: artifactTypes.tracking_plan.content.parse({ unknownEvents: 'block', unknownProperties: 'block', events: [] }),
  };
  const event = (name: string) => InboundEvent.parse({ type: 'track', event: name, anonymousId: 'a', properties: { internal: true } });

  it('lists every carrier event the platform emits through ingest', () => {
    expect([...PLATFORM_EVENTS].sort()).toEqual(
      [
        'Email Bounced',
        'Email Complained',
        'Email Delivered',
        'Email Link Clicked',
        'Email Sent',
        'Email Unsubscribed',
        'Form Submitted',
        'Subscription Confirmed',
        'Subscription Imported',
      ].sort(),
    );
  });

  it('accepts each platform event from an internal caller under a strict plan', () => {
    for (const name of PLATFORM_EVENTS) {
      expect(processEvent(event(name), server, strict, now, { messageId: () => 'x', internal: true }), name).toMatchObject({
        kind: 'accepted',
      });
    }
  });

  it('stays exempt from declared-property rejection too', () => {
    const planWithDeclaredProblem: WorkspacePolicy = {
      ...defaultPolicy,
      plan: artifactTypes.tracking_plan.content.parse({
        unknownEvents: 'block',
        unknownProperties: 'block',
        declaredProperties: 'block',
        events: [{ name: 'Form Submitted', properties: [{ name: 'form_id', type: 'number', required: true }] }],
      }),
    };
    const out = processEvent(
      InboundEvent.parse({ type: 'track', event: 'Form Submitted', anonymousId: 'a', properties: { form_id: 'frm_text' } }),
      server,
      planWithDeclaredProblem,
      now,
      { messageId: () => 'x', internal: true },
    );
    expect(out).toMatchObject({ kind: 'accepted' });
  });

  it('gives a public client no bypass, even on a server source', () => {
    for (const name of PLATFORM_EVENTS) {
      expect(processEvent(event(name), server, strict, now, { messageId: () => 'x' }), name).toMatchObject({ kind: 'rejected' });
    }
  });

  it('exempts a connector source’s own event names from the plan (#764)', () => {
    const order = { type: 'track', event: 'Order Completed', anonymousId: 'a' };
    const connector: SourceInfo = { ...server, platform: true };
    expect(acceptItems([order], connector, strict).rejected).toHaveLength(1);
    expect(acceptInternalItems([order], connector, strict).accepted).toHaveLength(1);
  });

  it('still deletes the plan’s declared personal properties on a connector event (#903)', () => {
    // #764 skipped the plan's rejection paths for connector events; it must not skip the plan's
    // declared-PII deletion. A custom-named personal property never matches the reserved list.
    const declared: WorkspacePolicy = {
      ...defaultPolicy,
      plan: artifactTypes.tracking_plan.content.parse({
        unknownEvents: 'block',
        unknownProperties: 'block',
        declaredProperties: 'block',
        events: [
          {
            name: 'order.completed',
            properties: [{ name: 'customer_email', pii: true }, { name: 'total' }],
          },
        ],
      }),
    };
    const connector: SourceInfo = { ...server, platform: true };
    const order = {
      type: 'track',
      event: 'order.completed',
      userId: 'u1',
      properties: { customer_email: 'buyer@example.com', total: 10 },
    };
    const out = processEvent(InboundEvent.parse(order), connector, declared, now, { messageId: () => 'x', internal: true });
    expect(out).toMatchObject({ kind: 'accepted' });
    if (out.kind !== 'accepted') throw new Error(out.kind);
    expect(out.event.properties).toEqual({ total: 10 });
    expect(acceptInternalItems([order], connector, declared).accepted[0]?.properties).toEqual({ total: 10 });

    // The rejection paths stay skipped: an unknown event name and an undeclared property are
    // accepted on a strict plan, because a connector payload is not the operator's own tracking.
    expect(
      processEvent(
        InboundEvent.parse({ type: 'track', event: 'Shopify Order', userId: 'u1', properties: { note: 'gift' } }),
        connector,
        declared,
        now,
        { messageId: () => 'x', internal: true },
      ),
    ).toMatchObject({ kind: 'accepted', event: { properties: { note: 'gift' } } });
  });

  it('exempts only the internal entry point, not the public one', () => {
    const item = { type: 'track', event: 'Form Submitted', anonymousId: 'a' };
    expect(acceptItems([item], server, strict).rejected).toHaveLength(1);
    expect(acceptInternalItems([item], server, strict).accepted).toHaveLength(1);
    // A public client keeps no bypass even on a server source; a connector marks its source
    // `platform`, which only the internal entry point honours (#764).
    expect(acceptItems([item], { ...server, kind: 'browser' }, strict).rejected).toHaveLength(1);
    expect(acceptItems([item], { ...server, platform: true }, strict).rejected).toHaveLength(1);
  });
});
