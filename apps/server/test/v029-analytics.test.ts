import type { BusEvent, JourneyEvent, MessageEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// Phase 16 (#75): the read-only metric layer. Two workspaces, events written straight into the
// same ClickHouse tables the workers use, and the same commands an agent gets over MCP.

const PORT = testPort(3474);
const TZ = 'Europe/Stockholm';
const FROM = '2026-02-28T00:00:00.000Z';
const TO = '2026-03-06T00:00:00.000Z';
const WIDE_FROM = '2026-02-01T00:00:00.000Z';
const JOURNEY = `jrn_${'9'.repeat(32)}`;
const B1 = `bct_${'1'.repeat(32)}`;
const B2 = `bct_${'2'.repeat(32)}`;
const B3 = `bct_${'3'.repeat(32)}`;
const B4 = `bct_${'4'.repeat(32)}`;
const B5 = `bct_${'5'.repeat(32)}`;
const B_OTHER = `bct_${'b'.repeat(32)}`;
const T1 = `eml_${'a'.repeat(32)}`;
const T2 = `eml_${'b'.repeat(32)}`;
const T3 = `eml_${'c'.repeat(32)}`;
const T4 = `eml_${'d'.repeat(32)}`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';
let profile = 0;
const person = () => `prf_${(++profile).toString(16).padStart(32, '0')}`;

interface Burst {
  broadcast: string;
  template: string;
  variant: string;
  at: string;
  people: number;
  delivered: number;
  clicked: number;
  opened: number;
  unsubscribed: number;
  bounced: number;
}

const bursts: Burst[] = [
  // 23:30 UTC is 00:30 the next day in Stockholm (CET): this row belongs to 1 March.
  {
    broadcast: B1,
    template: T1,
    variant: 'A',
    at: '2026-02-28T23:30:00.000Z',
    people: 6,
    delivered: 3,
    clicked: 2,
    opened: 1,
    unsubscribed: 1,
    bounced: 0,
  },
  {
    broadcast: B2,
    template: T1,
    variant: 'B',
    at: '2026-03-02T22:30:00.000Z',
    people: 10,
    delivered: 9,
    clicked: 1,
    opened: 5,
    unsubscribed: 1,
    bounced: 1,
  },
  // 23:30 UTC on 3 March is 00:30 on 4 March in Stockholm.
  {
    broadcast: B3,
    template: T2,
    variant: 'A',
    at: '2026-03-03T23:30:00.000Z',
    people: 6,
    delivered: 5,
    clicked: 2,
    opened: 2,
    unsubscribed: 1,
    bounced: 1,
  },
  {
    broadcast: B4,
    template: T3,
    variant: 'B',
    at: '2026-03-05T10:00:00.000Z',
    people: 6,
    delivered: 5,
    clicked: 1,
    opened: 1,
    unsubscribed: 0,
    bounced: 0,
  },
  // Older, and only three people: used for k-suppression and to prove "last four" ordering.
  {
    broadcast: B5,
    template: T4,
    variant: 'A',
    at: '2026-02-20T10:00:00.000Z',
    people: 3,
    delivered: 3,
    clicked: 1,
    opened: 1,
    unsubscribed: 0,
    bounced: 0,
  },
];

function messageEvents(workspaceId: string, list: Burst[]): MessageEvent[] {
  const out: MessageEvent[] = [];
  for (const b of list) {
    const people = Array.from({ length: b.people }, person);
    const type = (eventType: MessageEvent['type'], i: number) => ({
      workspaceId,
      messageId: `msg_${b.broadcast}_${i}`,
      eventId: `${b.broadcast}:${eventType}:${i}`,
      type: eventType,
      at: b.at,
      profileId: people[i],
      channel: 'email',
      purpose: 'marketing_email',
      provider: 'log',
      templateId: b.template,
      templateVersion: 1,
      journeyId: b.broadcast,
      variant: b.variant,
      reason: '',
      url: '',
    });
    for (let i = 0; i < b.people; i++) out.push(type('sent', i));
    for (let i = 0; i < b.delivered; i++) out.push(type('delivered', i));
    for (let i = 0; i < b.opened; i++) out.push(type('opened', i));
    for (let i = 0; i < b.clicked; i++) out.push(type('clicked', i));
    for (let i = b.people - b.unsubscribed; i < b.people; i++) if (b.unsubscribed) out.push(type('unsubscribed', i));
    for (let i = b.people - b.bounced; i < b.people; i++) if (b.bounced) out.push(type('bounced', i));
    out.push(type('complained', b.people - 1));
  }
  return out;
}

function journeyEvents(workspaceId: string, at: string, people: string[]): JourneyEvent[] {
  const out: JourneyEvent[] = [];
  const add = (p: string, seq: number, node: string, type: JourneyEvent['type']) =>
    out.push({
      workspaceId,
      journeyId: JOURNEY,
      version: 1,
      participantId: Number.parseInt(p.slice(-8), 16),
      profileId: p,
      node,
      type,
      seq,
      at,
      detail: '',
    });
  people.forEach((p, i) => {
    add(p, 0, 'trigger', 'entered');
    add(p, 1, 's1', 'step');
    if (i < 5) add(p, 2, 's2', 'step');
    if (i < 4) {
      add(p, 3, 'goal', 'converted');
      add(p, 4, 'goal', 'completed');
    }
  });
  add(people[5], 2, 's1', 'exited');
  return out;
}

const event = (workspaceId: string, i: number, total: number, currency: string, at: string): BusEvent => ({
  workspaceId,
  sourceId: 'test',
  messageId: `conv_${workspaceId}_${i}`,
  type: 'track',
  name: 'Order Completed',
  anonymousId: `anon_${workspaceId}_${i}`,
  userId: '',
  timestamp: at,
  receivedAt: at,
  properties: { total, currency },
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

const api = (workspaceId = wsA) => t.api(owner, workspaceId);
const columnIndex = (result: { columns: { name: string }[] }, name: string) => result.columns.findIndex((c) => c.name === name);
const cell = (result: { columns: { name: string }[]; rows: (string | number | null)[][] }, row: number, name: string) =>
  result.rows[row][columnIndex(result, name)];

beforeAll(async () => {
  t = await startTestServer('test_v029_analytics', PORT);
  owner = await t.signUp(`owner-analytics-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']], 'none');
  wsB = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('workspace.update', { timeZone: TZ });

  // A real published conversion map, so conversions and revenue follow the same rule the ads
  // delivery path reads. The connection needs no valid Meta credentials for reporting.
  const connection = await api().call('connections.create', {
    connector: 'meta_ads',
    name: 'Meta test',
    settings: { pixelId: '1234567890' },
    secrets: { accessToken: 'test-access-token-1234567890' },
  });
  const map = await api().call('artifacts.create', {
    type: 'conversion_map',
    name: 'Conversions',
    content: {
      rules: [
        {
          event: 'Order Completed',
          value: 'total',
          currencyProperty: 'currency',
          meta: { connection: connection.id, eventName: 'Purchase' },
        },
      ],
    },
  });
  await api().call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'v029 analytics test' });

  await t.srv.events.insertMessageEvents([
    ...messageEvents(wsA, bursts),
    ...messageEvents(wsB, [
      {
        broadcast: B_OTHER,
        template: T1,
        variant: 'A',
        at: '2026-03-02T10:00:00.000Z',
        people: 8,
        delivered: 8,
        clicked: 4,
        opened: 4,
        unsubscribed: 1,
        bounced: 0,
      },
    ]),
  ]);

  const people = Array.from({ length: 6 }, person);
  await t.srv.events.insertJourneyEvents(journeyEvents(wsA, '2026-03-02T12:00:00.000Z', people));

  await t.srv.events.insert([
    event(wsA, 1, 100, 'DKK', '2026-03-02T13:00:00.000Z'),
    event(wsA, 2, 50, 'DKK', '2026-03-02T14:00:00.000Z'),
    event(wsA, 3, 25, 'DKK', '2026-03-03T10:00:00.000Z'),
    event(wsA, 4, 40, 'EUR', '2026-03-03T11:00:00.000Z'),
    event(wsA, 5, 60, 'EUR', '2026-03-04T12:00:00.000Z'),
  ]);
});

afterAll(async () => {
  await t.close();
});

describe('analytics.query', () => {
  it('counts per template and per day in the workspace time zone, and computes ratios from bases', async () => {
    const byDay = await api().call('analytics.query', {
      measures: ['email.sent', 'email.clicked', 'email.click_rate'],
      dimensions: ['day'],
      from: FROM,
      to: TO,
      order: { by: 'day', dir: 'asc' },
    });
    expect(byDay.meta.timeZone).toBe(TZ);
    expect(byDay.rows.map((r) => r[columnIndex(byDay, 'day')])).toEqual(['2026-03-01', '2026-03-02', '2026-03-04', '2026-03-05']);
    expect(byDay.rows.map((_, i) => cell(byDay, i, 'email.sent'))).toEqual([6, 10, 6, 6]);
    expect(cell(byDay, 0, 'email.click_rate')).toBeCloseTo(2 / 3, 5);

    const byTemplate = await api().call('analytics.query', {
      measures: ['email.sent', 'email.delivered', 'email.bounced', 'email.clicked', 'email.click_rate', 'email.bounce_rate'],
      dimensions: ['template'],
      from: WIDE_FROM,
      to: TO,
    });
    const templates = byTemplate.rows.map((r) => r[columnIndex(byTemplate, 'template')]);
    expect(templates).toEqual([T1, T2, T3, T4]);
    expect(cell(byTemplate, 0, 'email.sent')).toBe(16);
    expect(cell(byTemplate, 0, 'email.delivered')).toBe(12);
    // 3 clickers over 12 delivered, not the average of the two broadcasts' rates.
    expect(cell(byTemplate, 0, 'email.click_rate')).toBeCloseTo(0.25, 5);
    expect(cell(byTemplate, 0, 'email.bounce_rate')).toBeCloseTo(1 / 16, 5);
    expect(byTemplate.meta.suppressed).toBe(1);
    expect(cell(byTemplate, 3, 'email.sent')).toBeNull();
    expect(byTemplate.meta.notes.join(' ')).toContain('aggregated base measures');
  });

  it('filters, and derives variant and message type from the message', async () => {
    const filtered = await api().call('analytics.query', {
      measures: ['email.sent'],
      dimensions: ['variant', 'message_type'],
      from: WIDE_FROM,
      to: TO,
      filters: { broadcast: [B1], purpose: 'marketing_email', channel: 'email' },
    });
    expect(filtered.rows).toHaveLength(1);
    expect(cell(filtered, 0, 'variant')).toBe('A');
    expect(cell(filtered, 0, 'message_type')).toBe('broadcast');
    expect(cell(filtered, 0, 'email.sent')).toBe(6);
  });

  it('refuses an invalid measure/dimension combination and names what is allowed', async () => {
    const err = await rejects(
      api().call('analytics.query', {
        measures: ['journey.entered'],
        dimensions: ['template'],
        from: FROM,
        to: TO,
      }),
    );
    expect(err.message).toContain('journey.entered');
    expect(err.message).toContain('template');
    expect(err.message).toContain('journey_step');
  });

  it('suppresses small breakdowns but not totals', async () => {
    const totals = await api().call('analytics.query', { measures: ['email.sent'], from: WIDE_FROM, to: TO });
    expect(totals.rows).toEqual([[31]]);
    expect(totals.meta.suppressed).toBe(0);

    const byTemplate = await api().call('analytics.query', {
      measures: ['email.sent'],
      dimensions: ['template'],
      from: WIDE_FROM,
      to: TO,
    });
    expect(byTemplate.meta.k).toBe(5);
    expect(byTemplate.meta.suppressed).toBe(1);
    expect(cell(byTemplate, 3, 'email.sent')).toBeNull();
  });

  it('never sees another workspace', async () => {
    const a = await api().call('analytics.query', { measures: ['email.sent'], dimensions: ['template'], from: WIDE_FROM, to: TO });
    expect(cell(a, 0, 'email.sent')).toBe(16);

    const b = await api(wsB).call('analytics.query', { measures: ['email.sent'], dimensions: ['template'], from: WIDE_FROM, to: TO });
    expect(b.rows).toHaveLength(1);
    expect(cell(b, 0, 'email.sent')).toBe(8);

    const notOurs = await api().call('analytics.query', {
      measures: ['email.sent'],
      from: WIDE_FROM,
      to: TO,
      filters: { broadcast: [B_OTHER] },
    });
    expect(notOurs.rows).toEqual([[0]]);
  });

  it('answers "how did the last four issues do" in one call', async () => {
    const result = await api().call('analytics.query', {
      measures: ['email.sent', 'email.click_rate', 'email.unsubscribe_rate'],
      dimensions: ['broadcast'],
      from: WIDE_FROM,
      to: TO,
      limit: 4,
      order: { by: 'broadcast', dir: 'desc' },
    });
    expect(result.rows.map((r) => r[columnIndex(result, 'broadcast')])).toEqual([B4, B3, B2, B1]);
    expect(result.rows.map((r) => r[columnIndex(result, 'email.sent')])).toEqual([6, 6, 10, 6]);
    expect(cell(result, 0, 'email.click_rate')).toBeCloseTo(1 / 5, 5);
    expect(cell(result, 2, 'email.click_rate')).toBeCloseTo(1 / 9, 5);
    expect(cell(result, 3, 'email.unsubscribe_rate')).toBeCloseTo(1 / 3, 5);
    expect(result.meta.notes.join(' ')).toContain('aggregated base measures');
  });

  it('splits revenue by currency instead of mixing it', async () => {
    const result = await api().call('analytics.query', {
      measures: ['conversions', 'revenue'],
      from: FROM,
      to: TO,
    });
    expect(result.columns.map((c) => c.name)).toEqual(['currency', 'conversions', 'revenue']);
    const rows = Object.fromEntries(result.rows.map((r) => [r[0], r.slice(1)]));
    expect(rows.DKK).toEqual([3, 175]);
    expect(rows.EUR).toEqual([2, 100]);
    expect(result.meta.currency).toBeNull();
    expect(result.meta.notes.join(' ')).toContain('different currencies are never added together');
  });

  it('exposes the metric catalogue', async () => {
    const catalog = await api().call('analytics.metrics.list', {});
    expect(catalog.measures.map((m) => m.id)).toEqual(
      expect.arrayContaining(['email.sent', 'email.click_rate', 'journey.entered', 'conversions', 'revenue', 'segment.members']),
    );
    expect(catalog.dimensions.map((d) => d.id)).toEqual(expect.arrayContaining(['day', 'broadcast', 'journey_step', 'variant']));
  });
});

describe('named reports', () => {
  it('emailPerformance by template uses the same measures and suppression', async () => {
    const result = await api().call('analytics.emailPerformance', { from: WIDE_FROM, to: TO, by: 'template' });
    expect(cell(result, 0, 'email.sent')).toBe(16);
    expect(cell(result, 0, 'email.click_rate')).toBeCloseTo(0.25, 5);
    expect(result.meta.suppressed).toBe(1);
  });

  it('journeyFunnel reports each step, drop-off, the goal and the exits', async () => {
    const funnel = await api().call('analytics.journeyFunnel', { journeyId: JOURNEY, from: FROM, to: TO });
    expect(funnel.entered).toBe(6);
    expect(funnel.goalReached).toBe(4);
    expect(funnel.completed).toBe(4);
    expect(funnel.exited).toBe(1);
    expect(funnel.steps.map((s) => s.step)).toEqual(['s1', 's2']);
    expect(funnel.steps[0]).toMatchObject({ reached: 6, dropOff: 0, dropOffRate: 0 });
    expect(funnel.steps[1].reached).toBe(5);
    expect(funnel.steps[1].dropOff).toBe(1);
    expect(funnel.steps[1].dropOffRate).toBeCloseTo(1 / 6, 5);
    expect(funnel.meta.suppressed).toBe(0);
  });
});
