import type {
  ApprovalRequest,
  EmailTemplate,
  Experience,
  Journey,
  JourneyEdge,
  JourneyNode,
  Profile,
  Segment,
} from '../api/types';

// Deterministic pseudo-random so the demo looks the same on every load.
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const DAY = 86_400_000;
export const NOW = Date.now();

/** The person the demo workspace is signed in as (the sample user in the demo fixtures, #110). */
export const DEMO_PERSONA = { name: 'Sara' } as const;

const people: [string, string, string][] = [
  ['Anna Jensen', 'Copenhagen', 'DK'],
  ['Lukas Schmidt', 'Berlin', 'DE'],
  ['Sofie Nielsen', 'Aarhus', 'DK'],
  ['Mikkel Andersen', 'Odense', 'DK'],
  ['Elin Svensson', 'Malmö', 'SE'],
  ['Jonas Berg', 'Oslo', 'NO'],
  ['Matteo Rossi', 'Milan', 'IT'],
  ['Chloé Martin', 'Lyon', 'FR'],
  ['Pieter de Vries', 'Utrecht', 'NL'],
  ['Aino Virtanen', 'Helsinki', 'FI'],
  ['Marta Kowalska', 'Kraków', 'PL'],
  ['Lucía García', 'Valencia', 'ES'],
  ['Freja Poulsen', 'Aalborg', 'DK'],
  ['Noah Christensen', 'Copenhagen', 'DK'],
  ['Ida Mortensen', 'Roskilde', 'DK'],
  ['Karl Johansson', 'Gothenburg', 'SE'],
  ['Laura Müller', 'Hamburg', 'DE'],
  ['Tomás Novák', 'Brno', 'CZ'],
  ['Oliver Hansen', 'Esbjerg', 'DK'],
  ['Maja Lindqvist', 'Uppsala', 'SE'],
];

function slug(name: string) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, '.');
}

export function seedProfiles(): Profile[] {
  const r = rng(7);
  return people.map(([name, city, country], i) => {
    const orders = Math.floor(r() * 9);
    const ltv = Math.round(orders * (380 + r() * 900));
    const lastSeen = NOW - Math.floor(r() * 75 * DAY);
    const inactive = NOW - lastSeen > 60 * DAY;
    const segments = [
      orders > 0 ? 'seg_customers' : 'seg_prospects',
      ...(r() > 0.5 ? ['seg_trail_runners'] : []),
      ...(orders >= 4 ? ['seg_vip'] : []),
      ...(inactive && orders > 0 ? ['seg_lapsed_60d'] : []),
    ];
    const objected = i === 0; // Anna objected to marketing e-mail: used in the copilot "explain" demo
    return {
      id: `prf_${(1000 + i * 37).toString(36)}${i}`,
      name,
      email: `${slug(name)}@example.com`,
      anonymousIds: [`anon_${Math.floor(r() * 1e8).toString(36)}`],
      city,
      country,
      traits: {
        first_name: name.split(' ')[0],
        locale: { DK: 'da-DK', DE: 'de-DE', SE: 'sv-SE', NO: 'nb-NO' }[country] ?? 'en-GB',
        preferred_category: ['shoes', 'jackets', 'tents', 'backpacks'][Math.floor(r() * 4)],
        newsletter: !objected && r() > 0.3,
        timezone: 'Europe/Copenhagen',
      },
      segments,
      consent: [
        {
          purpose: 'marketing_email',
          channel: 'email',
          basis: orders > 0 ? 'legitimate_interest' : 'consent',
          status: objected ? 'objected' : orders > 0 ? 'not_asked' : r() > 0.2 ? 'granted' : 'denied',
          source: objected ? 'Unsubscribe link, cart reminder e-mail' : orders > 0 ? 'Soft opt-in at checkout' : 'Newsletter form',
          at: NOW - Math.floor(r() * 200 * DAY),
        },
        {
          purpose: 'web_personalization',
          channel: 'web',
          basis: 'consent',
          status: r() > 0.25 ? 'granted' : 'denied',
          source: 'Cookie banner',
          at: NOW - Math.floor(r() * 90 * DAY),
        },
        {
          purpose: 'ai_processing',
          channel: 'any',
          basis: 'legitimate_interest',
          status: 'not_asked',
          source: 'Workspace policy (LIA-2026-03)',
          at: NOW - 120 * DAY,
        },
      ],
      lastSeen,
      ltv,
      orders,
      journeys: i % 3 === 0 ? ['jrn_welcome'] : i % 3 === 1 ? ['jrn_cart'] : [],
    } satisfies Profile;
  });
}

function n(
  id: string,
  kind: JourneyNode['kind'],
  label: string,
  x: number,
  y: number,
  config: JourneyNode['config'] = {},
  stats?: JourneyNode['stats'],
): JourneyNode {
  return { id, kind, label, position: { x: x * 1.15, y: y * 1.45 }, config, stats };
}
function e(source: string, target: string, label?: string): JourneyEdge {
  return { id: `${source}-${target}`, source, target, label };
}

const welcomeNodes = [
  n('t1', 'trigger', 'Signed up', 260, 0, { event: 'signed_up', reentry: 'once' }, { entered: 4812, active: 0 }),
  n('e1', 'email', 'Welcome e-mail', 260, 120, { template: 'tpl_welcome', purpose: 'onboarding' }, { entered: 4812, active: 3 }),
  n('w1', 'wait', 'Wait 2 days', 260, 240, { duration: 'P2D' }, { entered: 4790, active: 312 }),
  n('b1', 'waitEvent', 'Clicked the welcome e-mail?', 260, 360, { event: 'email_clicked', timeout: 'P2D' }, { entered: 4478, active: 201 }),
  n('a1', 'aiGenerate', 'AI: personalise tips intro', 40, 500, { slot: 'intro', prompt: 'prm_tips@2', maxChars: 280 }, { entered: 1712, active: 0 }),
  n('e2', 'email', 'Getting-started tips', 40, 620, { template: 'tpl_tips', purpose: 'onboarding' }, { entered: 1712, active: 0 }),
  n('e3', 'email', 'Your 10% welcome code', 480, 500, { template: 'tpl_code', purpose: 'marketing_email' }, { entered: 2565, active: 0 }),
  n('g1', 'goal', 'First order', 260, 760, { event: 'order_completed', within: 'P30D' }, { entered: 1094, active: 0 }),
];
const welcomeEdges = [
  e('t1', 'e1'),
  e('e1', 'w1'),
  e('w1', 'b1'),
  e('b1', 'a1', 'clicked'),
  e('b1', 'e3', 'timeout'),
  e('a1', 'e2'),
  e('e2', 'g1'),
  e('e3', 'g1'),
];

const cartNodes = [
  n('t1', 'trigger', 'Cart abandoned', 300, 0, { event: 'cart_abandoned', rule: '30 min without checkout' }, { entered: 2391, active: 0 }),
  n('w1', 'wait', 'Wait 1 hour', 300, 120, { duration: 'PT1H' }, { entered: 2391, active: 41 }),
  n('b1', 'branch', 'Ordered in the meantime?', 300, 240, { condition: 'event order_completed since entry' }, { entered: 2350, active: 0 }),
  n('x1', 'exit', 'Exit: converted', 620, 360, {}, { entered: 412, active: 0 }),
  n('s1', 'split', 'A/B: incentive', 160, 360, { a: 50, b: 50, holdout: 10 }, { entered: 1938, active: 0 }),
  n('ea', 'email', 'Reminder: 10% off', 0, 490, { template: 'tpl_cart', variant: 'A', purpose: 'marketing_email' }, { entered: 872, active: 0 }),
  n('eb', 'email', 'Reminder: free shipping', 320, 490, { template: 'tpl_cart', variant: 'B', purpose: 'marketing_email' }, { entered: 873, active: 0 }),
  n('w2', 'wait', 'Wait 1 day', 160, 610, { duration: 'P1D' }, { entered: 1745, active: 118 }),
  n('d1', 'aiDecide', 'AI: next best action', 160, 730, { options: 'last_chance | exit', fallback: 'exit', prompt: 'prm_nba@1' }, { entered: 1499, active: 0 }),
  n('e4', 'email', 'Last chance', 160, 860, { template: 'tpl_cart_last', purpose: 'marketing_email' }, { entered: 655, active: 0 }),
  n('g1', 'goal', 'Order completed', 160, 980, { event: 'order_completed', within: 'P7D' }, { entered: 538, active: 0 }),
];
const cartEdges = [
  e('t1', 'w1'),
  e('w1', 'b1'),
  e('b1', 'x1', 'yes'),
  e('b1', 's1', 'no'),
  e('s1', 'ea', 'A'),
  e('s1', 'eb', 'B'),
  e('ea', 'w2'),
  e('eb', 'w2'),
  e('w2', 'd1'),
  e('d1', 'e4', 'last chance'),
  e('e4', 'g1'),
];

// Agent-proposed v4 of the welcome series: adds an AI subject line step and changes the delay.
const welcomeV4Nodes = welcomeNodes.map((x) =>
  x.id === 'w1' ? { ...x, label: 'Wait 1 day', config: { duration: 'P1D' } } : x,
);
welcomeV4Nodes.splice(
  2,
  0,
  n('a0', 'aiGenerate', 'AI: subject line per segment', 520, 120, { slot: 'subject', prompt: 'prm_subject@1', maxChars: 60 }),
);
const welcomeV4Edges = [...welcomeEdges];

export function seedJourneys(): Journey[] {
  return [
    {
      id: 'jrn_welcome',
      name: 'Welcome series',
      purpose: 'onboarding',
      status: 'live',
      goal: 'First order within 30 days',
      metrics: { entered: 4812, active: 516, conversion: 22.7, holdoutUplift: 6.4 },
      versions: [
        { number: 3, state: 'published', author: { type: 'user', name: 'Tim' }, note: 'Added 10% code branch', createdAt: NOW - 21 * DAY, nodes: welcomeNodes, edges: welcomeEdges },
        { number: 4, state: 'in_review', author: { type: 'agent', name: 'Copilot' }, note: 'Shorter delay, AI subject lines per segment', createdAt: NOW - 2 * 3600_000, nodes: welcomeV4Nodes, edges: welcomeV4Edges },
      ],
    },
    {
      id: 'jrn_cart',
      name: 'Abandoned cart',
      purpose: 'marketing_email',
      status: 'live',
      goal: 'Order within 7 days',
      metrics: { entered: 2391, active: 159, conversion: 22.5, holdoutUplift: 9.1 },
      versions: [
        { number: 7, state: 'published', author: { type: 'user', name: 'Tim' }, note: 'AI next best action after day 1', createdAt: NOW - 9 * DAY, nodes: cartNodes, edges: cartEdges },
      ],
    },
    {
      id: 'jrn_backinstock',
      name: 'Back in stock',
      purpose: 'marketing_email',
      status: 'paused',
      goal: 'Order within 3 days',
      metrics: { entered: 611, active: 0, conversion: 31.2, holdoutUplift: 12.8 },
      versions: [
        {
          number: 2,
          state: 'published',
          author: { type: 'user', name: 'Tim' },
          note: 'Paused for summer range',
          createdAt: NOW - 40 * DAY,
          nodes: [
            n('t1', 'trigger', 'Product back in stock', 200, 0, { event: 'product_restocked', match: 'viewed in last 30 days' }),
            n('e1', 'email', 'It is back', 200, 120, { template: 'tpl_restock', purpose: 'marketing_email' }),
            n('g1', 'goal', 'Order completed', 200, 240, { event: 'order_completed', within: 'P3D' }),
          ],
          edges: [e('t1', 'e1'), e('e1', 'g1')],
        },
      ],
    },
  ];
}

export function seedSegments(): Segment[] {
  const u = { type: 'user', name: 'Tim' } as const;
  return [
    { id: 'seg_customers', name: 'Customers', definition: 'orders_count ≥ 1', size: 18_420, realtime: true, author: u },
    { id: 'seg_prospects', name: 'Prospects', definition: 'orders_count = 0 AND identified', size: 9_870, realtime: true, author: u },
    { id: 'seg_trail_runners', name: 'Trail runners', definition: 'product_viewed {category: shoes} ≥ 3 within 7d', size: 3_204, realtime: true, author: u },
    { id: 'seg_vip', name: 'VIP', definition: 'orders_count ≥ 4 OR ltv ≥ 5 000 DKK', size: 1_166, realtime: false, author: u },
    { id: 'seg_lapsed_60d', name: 'Lapsed 60 days', definition: 'customer AND no order_completed within 60d', size: 4_381, realtime: false, author: u },
  ];
}

export function seedExperiences(): Experience[] {
  return [
    {
      id: 'exp_hero',
      name: 'Homepage hero by interest',
      placement: 'home_hero',
      targeting: 'session: product_viewed {category} ≥ 3 → that category; else default',
      variants: [
        { id: 'default', name: 'Autumn range', weight: 10 },
        { id: 'shoes', name: 'Trail shoes picked for you', weight: 90 },
      ],
      status: 'live',
      exposures: 41_220,
      uplift: 14.2,
    },
    {
      id: 'exp_cart',
      name: 'Free-shipping nudge in cart',
      placement: 'cart_banner',
      targeting: 'cart_value between 600 and 799 DKK',
      variants: [
        { id: 'control', name: 'No banner', weight: 50 },
        { id: 'nudge', name: '“Add 200 kr for free shipping”', weight: 50 },
      ],
      status: 'live',
      exposures: 12_904,
      uplift: 7.8,
    },
  ];
}

const header = `<mj-section background-color="#2f5d43" padding="18px 24px">
      <mj-column><mj-text color="#f3efe6" font-size="20px" font-weight="700" font-family="Georgia, serif">Fjeldvej Outdoor</mj-text></mj-column>
    </mj-section>`;
const footer = `<mj-section padding="16px 24px">
      <mj-column>
        <mj-text font-size="11px" color="#6b7280">You get this e-mail because you created an account at Fjeldvej Outdoor.
          <a href="{{ unsubscribe_url }}" style="color:#2f5d43">Unsubscribe</a> · Fjeldvej Outdoor ApS, Vesterbrogade 1, 1620 København V</mj-text>
      </mj-column>
    </mj-section>`;

export function seedTemplates(): EmailTemplate[] {
  return [
    {
      id: 'tpl_welcome',
      name: 'Welcome e-mail',
      subject: 'Welcome to the trail, {{ profile.first_name | default: "friend" }}',
      purpose: 'onboarding',
      version: 5,
      updatedAt: NOW - 21 * DAY,
      author: { type: 'user', name: 'Tim' },
      mjml: `<mjml>
  <mj-body background-color="#f3efe6">
    ${header}
    <mj-section background-color="#ffffff" padding="28px 24px">
      <mj-column>
        <mj-text font-size="24px" font-family="Georgia, serif" color="#1f2a22">Hej {{ profile.first_name | default: "there" }}, welcome aboard</mj-text>
        <mj-text font-size="15px" line-height="1.6" color="#374151">Thanks for joining Fjeldvej. We pick gear the way you pick routes: for the weather you will actually meet. Here is what is popular in {{ profile.city | default: "your area" }} this week.</mj-text>
        <mj-button background-color="#2f5d43" href="https://example.com/{{ profile.preferred_category | default: 'new' }}">Explore {{ profile.preferred_category | default: "the autumn range" }}</mj-button>
      </mj-column>
    </mj-section>
    ${footer}
  </mj-body>
</mjml>`,
    },
    {
      id: 'tpl_cart',
      name: 'Cart reminder',
      subject: 'You left something behind, {{ profile.first_name }}',
      purpose: 'marketing_email',
      version: 9,
      updatedAt: NOW - 9 * DAY,
      author: { type: 'user', name: 'Tim' },
      mjml: `<mjml>
  <mj-body background-color="#f3efe6">
    ${header}
    <mj-section background-color="#ffffff" padding="28px 24px">
      <mj-column>
        <mj-text font-size="22px" font-family="Georgia, serif" color="#1f2a22">Still thinking it over?</mj-text>
        <mj-text font-size="15px" line-height="1.6" color="#374151">Your {{ cart.items[0].name | default: "Trailrunner GTX" }} is waiting in your cart. {% if variant == "A" %}Use code TRAIL10 for 10% off today.{% else %}Shipping is on us for the next 48 hours.{% endif %}</mj-text>
        <mj-button background-color="#2f5d43" href="https://example.com/cart">Back to my cart</mj-button>
      </mj-column>
    </mj-section>
    ${footer}
  </mj-body>
</mjml>`,
    },
  ];
}

export function seedApprovals(): ApprovalRequest[] {
  return [
    {
      id: 'apr_1',
      artifactType: 'journey',
      artifactId: 'jrn_welcome',
      artifactName: 'Welcome series',
      fromVersion: 3,
      toVersion: 4,
      requestedBy: { type: 'agent', name: 'Copilot' },
      status: 'pending',
      createdAt: NOW - 2 * 3600_000,
      summary: 'Welcome e-mail click rate dropped 3.1 pts over 4 weeks. Shorten the first delay and generate subject lines per segment.',
      changes: [
        { path: 'nodes.w1.label', kind: 'changed', before: 'Wait 2 days', after: 'Wait 1 day' },
        { path: 'nodes.w1.config.duration', kind: 'changed', before: 'P2D', after: 'P1D' },
        { path: 'nodes.a0', kind: 'added', after: 'aiGenerate “AI: subject line per segment” (slot: subject, max 60 chars, prompt prm_subject@1)' },
        { path: 'settings.ai_fallback', kind: 'added', after: 'Use template subject if generation fails or exceeds 60 chars' },
      ],
    },
    {
      id: 'apr_2',
      artifactType: 'template',
      artifactId: 'tpl_cart',
      artifactName: 'Cart reminder',
      fromVersion: 9,
      toVersion: 10,
      requestedBy: { type: 'user', name: 'Sara (marketing)' },
      status: 'pending',
      createdAt: NOW - 26 * 3600_000,
      summary: 'Copy tweak for variant B and a product image block.',
      changes: [
        { path: 'subject', kind: 'changed', before: 'You left something behind, {{ profile.first_name }}', after: '{{ profile.first_name }}, your gear is still in the cart' },
        { path: 'body.section[1].image', kind: 'added', after: 'mj-image {{ cart.items[0].image_url }}' },
      ],
    },
  ];
}

// 30 days of channel analytics.
export function seedDaily() {
  const r = rng(42);
  return Array.from({ length: 30 }, (_, i) => {
    const date = new Date(NOW - (29 - i) * DAY);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const sent = Math.round((weekend ? 900 : 1600) + r() * 500);
    const clicks = Math.round(sent * (0.042 + r() * 0.018));
    const conversions = Math.round(clicks * (0.18 + r() * 0.08));
    return {
      day: date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      sent,
      delivered: Math.round(sent * 0.987),
      clicks,
      unsubscribes: Math.round(sent * 0.0016 * (0.6 + r())),
      conversions,
      revenue: Math.round(conversions * (640 + r() * 260)),
      events: Math.round(42_000 + r() * 16_000 + (weekend ? 9000 : 0)),
    };
  });
}
