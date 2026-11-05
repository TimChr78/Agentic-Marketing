import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { createClient } from '@agentic-marketing/client';
import type { BusEvent, JourneyEvent, MessageEvent } from '@agentic-marketing/events';
import type { Commands } from '../../src/registry';
import { eventually, type startTestServer } from '../harness';

// A realistic workspace for UI work, screenshots and Playwright: a newsletter site (like the
// MartechSignal pilot) with people in each role, an agent token, published prerequisites and
// pending approvals of every reviewed type, plus weeks of deterministic activity (sends, opens,
// clicks, journey progress, conversions and agent actions) so every chart has something to show.
//
// Everything is generated from a seeded PRNG and a fixed clock (`opts.now`), so two runs of the
// same seed produce the same counts, rates and names.

type T = Awaited<ReturnType<typeof startTestServer>>;
export const PEOPLE = {
  owner: { email: 'alex@example.com', name: 'Alex Morgan' },
  builder: { email: 'sam@example.com', name: 'Sam Rivera' },
  approver: { email: 'jo@example.com', name: 'Jo Lee' },
  viewer: { email: 'vic@example.com', name: 'Vic Chen' },
};

const mjml = (title: string, body: string) => `<mjml>
  <mj-head><mj-attributes><mj-all font-family="Helvetica, Arial, sans-serif" /></mj-attributes></mj-head>
  <mj-body background-color="#f4f5f7">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="13px" color="#6b7280">MartechSignal</mj-text>
        <mj-text font-size="22px" font-weight="700" color="#111827">${title}</mj-text>
        <mj-text font-size="15px" line-height="24px" color="#374151">Hi {{ profile.firstName | default: 'there' }},</mj-text>
        <mj-text font-size="15px" line-height="24px" color="#374151">${body}</mj-text>
        <mj-button background-color="#1d4ed8" href="https://martechsignal.example/latest">Read the issue</mj-button>
        <mj-text font-size="12px" color="#6b7280"><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

/** A tiny PNG (solid colour) so the asset library has a real image. */
function png(w: number, h: number, rgb: [number, number, number]) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from(rgb))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Deterministic activity -------------------------------------------------------------------
// The fixtures use a fixed clock and a tiny PRNG, never Math.random or Date.now: screenshots and
// e2e assertions must see the same 500-odd people, the same weekly issues and the same rates.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const FIXED_NOW = new Date('2026-11-02T09:00:00Z');

/** mulberry32: small, fast, and stable across Node versions. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Random = () => number;
const pick = <X>(rng: Random, list: readonly X[]) => list[Math.floor(rng() * list.length)]!;
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE);
const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * HOUR);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
const hashId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

function shuffled<X>(list: readonly X[], rng: Random): X[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const FIRST_NAMES = [
  'Ada',
  'Grace',
  'Linus',
  'Margaret',
  'Ken',
  'Barbara',
  'Niels',
  'Freja',
  'Magnus',
  'Sofie',
  'Emil',
  'Clara',
  'Jonas',
  'Amalie',
  'Oscar',
  'Ida',
  'William',
  'Alma',
  'Noah',
  'Ella',
  'Lucas',
  'Ava',
  'Milan',
  'Liva',
  'Arthur',
  'Karla',
  'Felix',
  'Ellen',
  'Sander',
  'Agnes',
  'Malthe',
  'Frida',
  'Viggo',
  'Ingrid',
  'Anton',
  'Nanna',
  'Rasmus',
  'Mette',
  'Tobias',
  'Sara',
] as const;

const LAST_NAMES = [
  'Morgan',
  'Rivera',
  'Lee',
  'Chen',
  'Nielsen',
  'Jensen',
  'Hansen',
  'Pedersen',
  'Andersen',
  'Christensen',
  'Larsen',
  'Sørensen',
  'Rasmussen',
  'Jørgensen',
  'Petersen',
  'Madsen',
  'Kristensen',
  'Olsen',
  'Thomsen',
  'Christiansen',
  'Poulsen',
  'Johansen',
  'Møller',
  'Mortensen',
  'Knudsen',
  'Jakobsen',
  'Jacobsen',
  'Olesen',
  'Frederiksen',
  'Mikkelsen',
  'Henriksen',
  'Laursen',
  'Lund',
  'Schmidt',
  'Eriksen',
  'Holm',
  'Kristiansen',
  'Clausen',
  'Simonsen',
  'Svendsen',
] as const;

/** A city and the IANA zone a reader in it would carry (used by send windows and the profile). */
const CITIES = [
  ['Copenhagen', 'Europe/Copenhagen'],
  ['Aarhus', 'Europe/Copenhagen'],
  ['Odense', 'Europe/Copenhagen'],
  ['Aalborg', 'Europe/Copenhagen'],
  ['Stockholm', 'Europe/Stockholm'],
  ['London', 'Europe/London'],
  ['Berlin', 'Europe/Berlin'],
  ['Amsterdam', 'Europe/Amsterdam'],
  ['Paris', 'Europe/Paris'],
  ['Lisbon', 'Europe/Lisbon'],
  ['New York', 'America/New_York'],
  ['Chicago', 'America/Chicago'],
  ['Austin', 'America/Chicago'],
  ['Denver', 'America/Denver'],
  ['San Francisco', 'America/Los_Angeles'],
  ['Vancouver', 'America/Vancouver'],
  ['Toronto', 'America/Toronto'],
  ['São Paulo', 'America/Sao_Paulo'],
  ['Singapore', 'Asia/Singapore'],
  ['Tokyo', 'Asia/Tokyo'],
  ['Sydney', 'Australia/Sydney'],
  ['Melbourne', 'Australia/Melbourne'],
  ['Cape Town', 'Africa/Johannesburg'],
  ['Nairobi', 'Africa/Nairobi'],
  ['Dubai', 'Asia/Dubai'],
] as const;

const LONG_FIRST_NAMES = ['Alexandria-Cassandra', 'Maximilian-Alexander', 'Sophia-Isabella-Maria', 'Bartholomew-Jonathan'] as const;
const LONG_LAST_NAMES = [
  'Montgomery-Worthington-Smythe',
  'Van Der Berg-Østergaard-Jensen',
  'Featherstonehaugh-Cavendish',
  'De La Cruz-Washington-Hamilton',
] as const;

const COMPANIES = [
  'Northwind Studio',
  'Tiny Lighthouse',
  'Kite & Co',
  'Orbit Analytics',
  'Harbour Labs',
  'Paper Planes',
  'Signal Craft',
  'Blueberry Digital',
] as const;

type ConsentStatus = 'granted' | 'denied' | 'withdrawn' | 'objected';
interface SeedPerson {
  userId: string;
  email: string;
  traits: Record<string, unknown>;
  consent: { purpose: string; status: ConsentStatus; recordedAt: string; proof: Record<string, unknown> }[];
}

const baseConsent = (status: ConsentStatus, recordedAt: string): SeedPerson['consent'] => [
  { purpose: 'marketing_email', status, recordedAt, proof: { system: 'Kit', import: 'MartechSignal' } },
];

/** The 24 named readers the existing specs use (`reader1@example.net` …), plus 496 generated readers. */
function seedPeople(now: Date, rng: Random): SeedPerson[] {
  const readers: SeedPerson[] = Array.from({ length: 24 }, (_, i) => ({
    userId: `reader-${i + 1}`,
    email: `reader${i + 1}@example.net`,
    traits: { firstName: ['Ada', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara'][i % 6], city: i % 2 ? 'Copenhagen' : 'Aarhus' },
    consent: baseConsent(i % 7 === 6 ? 'withdrawn' : 'granted', '2026-09-01T08:00:00Z'),
  }));

  const generated: SeedPerson[] = Array.from({ length: 496 }, (_, i) => {
    const n = i + 1;
    const longName = n % 83 === 0;
    const first = longName ? pick(rng, LONG_FIRST_NAMES) : pick(rng, FIRST_NAMES);
    const last = longName ? pick(rng, LONG_LAST_NAMES) : pick(rng, LAST_NAMES);
    const [city, timezone] = pick(rng, CITIES);
    const includeFirst = n % 13 !== 0;
    const includeCity = n % 11 !== 0;
    const includeZone = n % 17 !== 0;
    const includeCompany = n % 19 !== 0;
    const traits: Record<string, unknown> = {};
    if (includeFirst) traits.firstName = first;
    traits.lastName = last;
    if (includeCity) traits.city = city;
    if (includeZone) traits.timezone = timezone;
    if (includeCompany) traits.company = pick(rng, COMPANIES);
    // Most gave consent; a believable minority did not, and a few left the list over time.
    const status: ConsentStatus = n % 23 === 0 ? 'withdrawn' : n % 31 === 0 ? 'denied' : n % 37 === 0 ? 'objected' : 'granted';
    // Before the oldest seeded send, so a later unsubscribe is always the newest consent record.
    const recordedAt = new Date(now.getTime() - (60 + Math.floor(rng() * 340)) * DAY).toISOString();
    return {
      userId: `seed-person-${String(n).padStart(3, '0')}`,
      email: longName ? `long-name-${n}@example.com` : `${`${first}.${last}.${n}`.toLowerCase().replace(/[^a-z0-9.@-]/g, '')}@example.com`,
      traits,
      consent: baseConsent(status, recordedAt),
    };
  });

  return [...readers, ...generated];
}

interface IssuePlan {
  number: number;
  subject: string;
  title: string;
  body: string;
  sendAt: Date;
  open: number;
  click: number;
  bounce: number;
  complaint: number;
  unsub: number;
  agent: boolean;
}

/** Eight weekly issues, oldest first, so events can be written in the order they happened. */
function issuePlan(now: Date): IssuePlan[] {
  const issues: Omit<IssuePlan, 'sendAt'>[] = [
    {
      number: 33,
      subject: 'Signal #33: the spreadsheet is not a CDP',
      title: 'Signal #33',
      body: 'This week: why a shared spreadsheet quietly becomes a customer data platform, and the three columns that always go stale first.',
      open: 0.44,
      click: 0.09,
      bounce: 4,
      complaint: 0,
      unsub: 3,
      agent: false,
    },
    {
      number: 34,
      subject: 'Signal #34: consent is a feature, not a checkbox',
      title: 'Signal #34',
      body: 'A practical consent ledger: what to record, where the proof lives, and why “they ticked a box” is not enough at audit time.',
      open: 0.47,
      click: 0.11,
      bounce: 3,
      complaint: 0,
      unsub: 2,
      agent: false,
    },
    {
      number: 35,
      subject: 'Signal #35: deliverability is a product metric',
      title: 'Signal #35',
      body: 'Bounce and complaint rates belong on the same dashboard as signups. Here is the small set of numbers worth watching.',
      open: 0.5,
      click: 0.12,
      bounce: 3,
      complaint: 0,
      unsub: 2,
      agent: false,
    },
    {
      number: 36,
      subject: 'Signal #36: attribution is a story you tell',
      title: 'Signal #36',
      body: 'Last click keeps winning arguments it should lose. A gentler way to show which touches actually moved the outcome.',
      open: 0.45,
      click: 0.1,
      bounce: 4,
      complaint: 1,
      unsub: 2,
      agent: false,
    },
    {
      number: 37,
      subject: 'Signal #37: the quiet power of a good wait step',
      title: 'Signal #37',
      body: 'Journeys that hurry lose people. What a two-day wait does to opens, and when a branch is better than another e-mail.',
      open: 0.49,
      click: 0.13,
      bounce: 3,
      complaint: 0,
      unsub: 2,
      agent: true,
    },
    {
      number: 38,
      subject: 'Signal #38: experiments your list can survive',
      title: 'Signal #38',
      body: 'Small audiences still support honest tests. Holdouts, sequential checks and the sample sizes that keep you out of trouble.',
      open: 0.52,
      click: 0.14,
      bounce: 3,
      complaint: 0,
      unsub: 1,
      agent: true,
    },
    {
      number: 39,
      subject: 'Signal #39: the archaeology of an unopened e-mail',
      title: 'Signal #39',
      body: 'Reasons people do not open are rarely about the copy. We dug through a year of subject lines and inbox placement data.',
      open: 0.54,
      click: 0.15,
      bounce: 2,
      complaint: 0,
      unsub: 2,
      agent: true,
    },
    {
      number: 40,
      subject: 'Signal #40: the inbox metric that matters',
      title: 'Signal #40',
      body: 'Forget the vanity chart. The one number that predicted renewals for 40 newsletters was repeat opens within fourteen days.',
      open: 0.56,
      click: 0.16,
      bounce: 3,
      complaint: 1,
      unsub: 2,
      agent: true,
    },
  ];
  return issues.map((issue, i) => ({
    ...issue,
    sendAt: addHours(addDays(now, -(issues.length - 1 - i) * 7), -12),
  }));
}

const issueMjml = (title: string, body: string, href: string, cta: string) => `<mjml>
  <mj-head><mj-attributes><mj-all font-family="Helvetica, Arial, sans-serif" /></mj-attributes></mj-head>
  <mj-body background-color="#f4f5f7">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="13px" color="#6b7280">MartechSignal</mj-text>
        <mj-text font-size="22px" font-weight="700" color="#111827">${title}</mj-text>
        <mj-text font-size="15px" line-height="24px" color="#374151">Hi {{ profile.firstName | default: 'there' }},</mj-text>
        <mj-text font-size="15px" line-height="24px" color="#374151">${body}</mj-text>
        <mj-button background-color="#1d4ed8" href="${href}">${cta}</mj-button>
        <mj-text font-size="12px" color="#6b7280"><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

/** `confirmedUrl`: where the signup form sends people after they confirm (default: the pilot site). */
export async function seed(t: T, opts: { confirmedUrl?: string; now?: Date } = {}) {
  const now = opts.now ?? FIXED_NOW;
  const rng = mulberry32(434);
  const users = {
    owner: await t.signUp(PEOPLE.owner.email),
    builder: await t.signUp(PEOPLE.builder.email),
    approver: await t.signUp(PEOPLE.approver.email),
    viewer: await t.signUp(PEOPLE.viewer.email),
  };
  for (const [k, u] of Object.entries(users))
    await t.srv.db.admin.query('UPDATE "user" SET name = $1 WHERE id = $2', [PEOPLE[k as keyof typeof PEOPLE].name, u.id]);
  const ws = await t.workspaceWith(
    [
      [users.owner, 'owner'],
      [users.builder, 'marketer'],
      [users.approver, 'approver'],
      [users.viewer, 'viewer'],
    ],
    'agent_changes',
  );
  await t.srv.db.admin.query(`UPDATE workspaces SET name = 'MartechSignal', time_zone = 'UTC' WHERE id = $1`, [ws]);
  const sandbox = await t.workspaceWith([[users.owner, 'admin']], 'none');
  await t.srv.db.admin.query(`UPDATE workspaces SET name = 'Sandbox' WHERE id = $1`, [sandbox]);

  const owner = t.api(users.owner, ws);
  await owner.call('workspace.setSeedList', { seedList: ['inbox-check@example.com'] }).catch(() => {});
  await owner.call('emailProviders.create', {
    name: 'Development log',
    adapter: 'log',
    fromEmail: 'news@martechsignal.example',
    fromName: 'MartechSignal',
    useFor: ['transactional', 'marketing'],
  });
  await owner.call('secrets.set', { name: 'turnstile.secret_key', value: 'dev-secret-not-real' });

  const logo = await owner.call('assets.upload', {
    fileName: 'martechsignal-logo.png',
    contentType: 'image/png',
    dataBase64: png(160, 40, [29, 78, 216]).toString('base64'),
    altText: 'MartechSignal',
  });
  await owner.call('assets.upload', {
    fileName: 'issue-43-hero.png',
    contentType: 'image/png',
    dataBase64: png(600, 300, [15, 122, 131]).toString('base64'),
    altText: 'Chart of e-mail engagement by weekday',
  });

  const pub = async (id: string, note: string) => owner.call('artifacts.requestPublish', { artifactId: id, note });
  const brand = await owner.call('artifacts.create', {
    type: 'brand',
    name: 'Brand',
    content: {
      siteName: 'MartechSignal',
      siteUrl: 'https://martechsignal.example',
      logoUrl: logo.url,
      logoAlt: 'MartechSignal',
      colors: { accent: '#1d4ed8' },
      language: 'en',
      archive: {
        enabled: true,
        title: 'The MartechSignal archive',
        description: 'Every issue of the weekly Signal, on the web.',
        slug: 'martechsignal',
        subscribeUrl: 'https://martechsignal.example/#signup',
      },
    },
  });
  await pub(brand.artifactId, 'Initial brand');

  // Topics under the newsletter purpose (#84), so the hosted preference centre has choices.
  const purposes = await owner.call('artifacts.create', {
    type: 'purposes',
    name: 'Purposes',
    content: {
      purposes: DEFAULT_PURPOSES.map((p) =>
        p.key === 'marketing_email'
          ? {
              ...p,
              topics: [
                { key: 'newsletter', name: 'Weekly newsletter', description: 'The Friday issue', default: 'subscribed' as const },
                { key: 'product_news', name: 'Product news', description: 'Launches and changes', default: 'unsubscribed' as const },
              ],
            }
          : p,
      ),
    },
  });
  await pub(purposes.artifactId, 'Purposes with topics');

  const confirm = await owner.call('artifacts.create', {
    type: 'email_template',
    name: 'Confirm your subscription',
    content: {
      purpose: 'onboarding',
      subject: 'Confirm your MartechSignal subscription',
      preheader: 'One click and you are in',
      mjml: mjml('Confirm your subscription', 'Click below to confirm. <a href="{{ confirm_url }}">Confirm</a>'),
      sampleData: { profile: { firstName: 'Ada' }, confirm_url: 'https://links.example/f/confirm/sample' },
    },
  });
  await pub(confirm.artifactId, 'Confirmation e-mail');
  const issue42 = await owner.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly Signal #42',
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #42: attribution is a story you tell',
      preheader: 'Plus three tools worth a look',
      mjml: mjml('Signal #42', 'This week: why last-click attribution keeps winning arguments it should lose.'),
      sampleData: { profile: { firstName: 'Ada' } },
    },
  });
  await pub(issue42.artifactId, 'Issue 42');
  const subscribers = await owner.call('artifacts.create', {
    type: 'segment',
    name: 'Newsletter subscribers',
    content: { description: 'Everyone who allows the newsletter.', condition: { consent: 'marketing_email' } },
  });
  await pub(subscribers.artifactId, 'All subscribers');
  const engaged = await owner.call('artifacts.create', {
    type: 'segment',
    name: 'Engaged readers',
    content: {
      description: 'Subscribers who opened recently.',
      condition: { all: [{ consent: 'marketing_email' }, { event: 'Email Opened', within: 'P30D' }] },
    },
  });
  await pub(engaged.artifactId, 'Engaged readers');
  const form = await owner.call('artifacts.create', {
    type: 'form',
    name: 'Newsletter signup',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: true,
      confirmationTemplate: confirm.artifactId,
      consentText: 'Send me the weekly MartechSignal newsletter. Unsubscribe at any time.',
      traits: ['firstName'],
      successUrl: 'https://martechsignal.example/thanks',
      confirmedUrl: opts.confirmedUrl ?? 'https://martechsignal.example/welcome',
      allowedOrigins: ['https://martechsignal.example'],
    },
  });
  await pub(form.artifactId, 'Signup form');
  // No thank-you page on the site: confirming shows the branded confirmed page (#115).
  const footerForm = await owner.call('artifacts.create', {
    type: 'form',
    name: 'Footer signup',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: true,
      confirmationTemplate: confirm.artifactId,
      consentText: 'Send me the weekly MartechSignal newsletter. Unsubscribe at any time.',
      traits: [],
      successUrl: 'https://martechsignal.example/thanks',
      allowedOrigins: ['https://martechsignal.example'],
    },
  });
  await pub(footerForm.artifactId, 'Footer signup form');

  // The 24 named readers the specs use, plus 496 generated ones: ~520 people with consent
  // recorded over the past year, a few missing traits and some very long names.
  const people = seedPeople(now, rng);
  await owner.call('profiles.import', { label: 'Kit export 2026-10-20', rows: people });

  // Imports travel the event bus, so wait for identity resolution before messages reference a person.
  const imported = await eventually(
    async () => {
      const { rows } = await t.srv.db.admin.query<{ value: string; profile_id: string }>(
        `SELECT value, profile_id FROM identifiers
         WHERE workspace_id = $1 AND type = 'user_id' AND value = ANY($2::text[])`,
        [ws, people.map((p) => p.userId)],
      );
      return rows;
    },
    (rows) => rows.length >= people.length,
    45_000,
  );
  const profileOf = new Map(imported.map((r) => [r.value, r.profile_id]));
  if (profileOf.size < people.length) throw new Error(`seeded ${profileOf.size} of ${people.length} people`);

  // A refresh forces membership now rather than waiting for the next segment tick.
  await eventually(
    () => owner.call('segments.refresh', { artifactId: subscribers.artifactId }),
    (r) => r.members >= 400,
    30_000,
  );

  // One sent issue for the public archive (#100), recorded as done without sending: sendAt is far
  // enough in the future that the scheduler never picks it up, and the archive reads the run.
  const archivedBroadcast = await owner.call('artifacts.create', {
    type: 'broadcast',
    name: 'Signal #41: the archive issue',
    content: {
      template: issue42.artifactId,
      segment: subscribers.artifactId,
      sendAt: '2027-01-08T09:00:00Z',
      archive: { publish: true, summary: 'The issue that opened the archive.' },
    },
  });
  await pub(archivedBroadcast.artifactId, 'Archive example');
  const archivedVersion = await owner.call('artifacts.get', { artifactId: archivedBroadcast.artifactId });
  await t.srv.db.admin.query(
    `INSERT INTO broadcast_runs (workspace_id, broadcast_id, version, status, send_at, started_at, finished_at)
     VALUES ($1, $2, $3, 'done', now(), now(), now())
     ON CONFLICT (workspace_id, broadcast_id)
     DO UPDATE SET status = 'done', started_at = now(), finished_at = now()`,
    [ws, archivedBroadcast.artifactId, archivedVersion.publishedVersion],
  );
  const archivedIssue = (await owner.call('archive.issues', {})).issues.find((i) => i.artifactId === archivedBroadcast.artifactId);

  // The agent: an API token owned by the builder, as Hermes uses on the pilot.
  const builder = t.api(users.builder, ws);
  const token = await builder.call('apiTokens.create', {
    name: 'Hermes',
    scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    expiresInDays: 90,
  });
  await builder.call('apiTokens.create', { name: 'n8n reporting', scopes: ['artifacts:read'] });
  const agent = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });
  // An agent cannot administer workspace settings (#106); it proposes, and the owner approves
  // the change from the Approvals page.
  await agent.call('workspace.proposeUpdate', {
    timeZone: 'Europe/Copenhagen',
    note: 'The editorial team and most readers are in Denmark; display dates in Copenhagen time.',
  });
  const ask = (id: string, note: string) => agent.call('artifacts.requestPublish', { artifactId: id, note });

  const issue43 = await agent.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly Signal #43',
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #43: the inbox is the new homepage',
      preheader: 'Why readers trust e-mail more than feeds',
      mjml: mjml(
        'Signal #43',
        'Feeds come and go; the inbox stays. This week we look at what 1,200 newsletters taught us about Tuesday sends.',
      ),
      sampleData: { profile: { firstName: 'Ada' } },
    },
  });
  await ask(issue43.artifactId, 'Draft of issue 43 from the editorial outline. Subject tested against #41 and #42.');

  const bc = await agent.call('artifacts.create', {
    type: 'broadcast',
    name: 'Signal #42 resend to engaged readers',
    content: {
      template: issue42.artifactId,
      segment: engaged.artifactId,
      sendAt: '2026-10-30T09:00:00+01:00',
      description: 'Resend of #42 to readers who opened in the last 30 days.',
    },
  });
  await ask(bc.artifactId, 'Resend #42 on Friday morning, Copenhagen time.');

  // The weekly flow since #107: next issue's template and the broadcast that sends it, one review.
  const issue44 = await agent.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly Signal #44',
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #44: one review per issue',
      mjml: mjml('Signal #44', 'This issue and its send were approved together.'),
    },
  });
  const send44 = await agent.call('artifacts.create', {
    type: 'broadcast',
    name: 'Send Signal #44',
    content: { template: issue44.artifactId, segment: engaged.artifactId, sendAt: '2026-11-06T09:00:00+01:00' },
  });
  await agent.call('artifacts.requestPublishBundle', {
    artifactIds: [send44.artifactId, issue44.artifactId],
    note: 'Issue 44 and its Friday send, for one review.',
  });

  await agent.call('artifacts.updateDraft', {
    artifactId: engaged.artifactId,
    content: {
      description: 'Subscribers who opened or clicked recently.',
      condition: {
        all: [
          { consent: 'marketing_email' },
          {
            any: [
              { event: 'Email Opened', within: 'P14D' },
              { event: 'Email Clicked', within: 'P30D' },
            ],
          },
        ],
      },
    },
  });
  await ask(engaged.artifactId, 'Tighten to 14 days of opens, or a click in 30 days.');

  await agent.call('artifacts.updateDraft', {
    artifactId: form.artifactId,
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: true,
      confirmationTemplate: confirm.artifactId,
      consentText: 'Yes, send me MartechSignal every Tuesday. I can unsubscribe with one click in any issue.',
      traits: ['firstName', 'company'],
      successUrl: 'https://martechsignal.example/thanks',
      confirmedUrl: 'https://martechsignal.example/welcome',
      allowedOrigins: ['https://martechsignal.example'],
    },
  });
  await ask(form.artifactId, 'Clearer consent wording and a company field.');

  const welcome = await agent.call('artifacts.create', {
    type: 'journey',
    name: 'Welcome series',
    content: {
      purpose: 'marketing_email',
      goal: 'Reader opens two issues in the first two weeks',
      nodes: [
        {
          id: 'n1',
          kind: 'trigger',
          label: 'Confirmed subscription',
          config: { event: 'Subscription Confirmed', reentry: 'once' },
          next: [{ to: 'n2' }],
        },
        { id: 'n2', kind: 'email', label: 'Welcome e-mail', config: { template: issue42.artifactId }, next: [{ to: 'n3' }] },
        { id: 'n3', kind: 'wait', label: 'Wait two days', config: { duration: 'P2D' }, next: [{ to: 'n4' }] },
        {
          id: 'n4',
          kind: 'branch',
          label: 'Opened the welcome?',
          config: { segment: engaged.artifactId },
          next: [{ to: 'n5' }, { to: 'n6' }],
        },
        { id: 'n5', kind: 'exit', label: 'Done', config: {} },
        { id: 'n6', kind: 'email', label: 'Best of MartechSignal', config: { template: issue42.artifactId }, next: [{ to: 'n7' }] },
        { id: 'n7', kind: 'exit', label: 'Exit', config: {} },
      ],
    },
  });
  await agent.call('artifacts.requestPublish', {
    artifactId: welcome.artifactId,
    note: 'Two-step welcome: issue 42 now, and again after two days for people who did not open it.',
  });

  await agent.call('artifacts.create', {
    type: 'experience',
    name: 'Newsletter banner on articles',
    content: {
      placement: 'article-footer',
      variants: [{ id: 'a', name: 'Short pitch', weight: 50, content: { html: '<p>Get the Tuesday signal.</p>' } }],
    },
  });

  // --- Weeks of believable activity (#434) -------------------------------------------------
  // Sends, deliveries, opens, clicks, bounces, complaints and unsubscribes are written the way the
  // delivery worker writes them: messages in Postgres, events through the event store, consent
  // through consent.record. Everything is backdated, so the history is real history.

  const hermesId = (await agent.call('agents.get', {})).id;
  const recentMinutes = (at: Date) => new Date(Math.min(at.getTime(), now.getTime() - 5 * MINUTE));

  const subscriberRows = await t.srv.db.admin.query<{ profile_id: string }>(
    `SELECT profile_id FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2 ORDER BY profile_id`,
    [ws, subscribers.artifactId],
  );
  const audience = subscriberRows.rows.map((r) => r.profile_id);
  if (audience.length < 400) throw new Error(`the subscribers segment has only ${audience.length} people`);
  const blocked = new Set<string>();

  /** Writes one sent issue's messages and events; returns the counts the run row needs. */
  async function writeIssue(opts: {
    number: number;
    templateId: string;
    broadcastId: string;
    sendAt: Date;
    recipients: string[];
    open: number;
    click: number;
    bounce: number;
    complaint: number;
    unsub: number;
  }) {
    const pool = shuffled(opts.recipients, rng);
    const bounced = new Set(pool.slice(0, opts.bounce));
    const complained = new Set(pool.slice(opts.bounce, opts.bounce + opts.complaint));
    const unsubscribed = new Set(pool.slice(opts.bounce + opts.complaint, opts.bounce + opts.complaint + opts.unsub));
    const rows: Record<string, unknown>[] = [];
    const events: MessageEvent[] = [];
    const withdrawn: { profileId: string; messageId: string; at: Date }[] = [];
    const sendAt = opts.sendAt.toISOString();
    const maxOpenMs = Math.max(HOUR, Math.min(36 * HOUR, now.getTime() - opts.sendAt.getTime() - HOUR));
    let delivered = 0;
    let opened = 0;
    let clicked = 0;

    for (const profileId of pool) {
      const messageId = `msg_${hashId(`${opts.broadcastId}:${profileId}`)}`;
      const isBounced = bounced.has(profileId);
      const isComplained = complained.has(profileId);
      const isUnsubscribed = unsubscribed.has(profileId);
      const didOpen = !isBounced && !isComplained && rng() < opts.open;
      const didClick = didOpen && rng() < opts.click / opts.open;
      const status = isBounced ? 'bounced' : isComplained ? 'complained' : 'delivered';
      if (!isBounced) delivered++;
      if (didOpen) opened++;
      if (didClick) clicked++;

      const deliveredAt = addMinutes(opts.sendAt, 1 + Math.floor(rng() * 3));
      const openedAt = recentMinutes(new Date(deliveredAt.getTime() + Math.floor(rng() * maxOpenMs)));
      const clickedAt = recentMinutes(new Date(openedAt.getTime() + 5 + Math.floor(rng() * 8 * 60) * MINUTE));
      const complainedAt = recentMinutes(addHours(deliveredAt, 6 + Math.floor(rng() * 30)));
      const unsubscribedAt = recentMinutes(addHours(deliveredAt, 2 + Math.floor(rng() * 40)));
      const link =
        rng() < 0.5
          ? `https://martechsignal.example/latest?utm_source=newsletter&utm_medium=email&utm_campaign=signal-week-${opts.number}`
          : `https://martechsignal.example/tools?utm_source=newsletter&utm_medium=email&utm_campaign=signal-week-${opts.number}`;

      rows.push({
        id: messageId,
        idempotency_key: `bct:${opts.broadcastId}:${profileId}`,
        profile_id: profileId,
        template_id: opts.templateId,
        journey_id: opts.broadcastId,
        status,
        created_at: sendAt,
        updated_at: recentMinutes(addMinutes(opts.sendAt, 30)).toISOString(),
      });

      const event = (type: MessageEvent['type'], at: Date, extra: Partial<MessageEvent> = {}) =>
        events.push({
          workspaceId: ws,
          messageId,
          eventId: `${messageId}:${type}${extra.url ? ':link' : ''}`,
          type,
          at: at.toISOString(),
          profileId,
          channel: 'email',
          purpose: 'marketing_email',
          provider: 'log',
          templateId: opts.templateId,
          templateVersion: 1,
          journeyId: opts.broadcastId,
          variant: '',
          reason: '',
          url: '',
          ...extra,
        });
      event('queued', addMinutes(opts.sendAt, -2));
      event('sent', opts.sendAt);
      if (!isBounced) event('delivered', deliveredAt);
      if (isBounced) event('bounced', deliveredAt, { reason: 'hard bounce: mailbox unavailable' });
      if (didOpen) event('opened', openedAt);
      if (didClick) event('clicked', clickedAt, { url: link });
      if (isComplained) event('complained', complainedAt, { reason: 'marked as spam' });
      if (isUnsubscribed) event('unsubscribed', unsubscribedAt);
      if (isComplained) {
        event('unsubscribed', complainedAt);
        withdrawn.push({ profileId, messageId, at: complainedAt });
      } else if (isUnsubscribed) {
        withdrawn.push({ profileId, messageId, at: unsubscribedAt });
      }
      if (isBounced || isComplained || isUnsubscribed) blocked.add(profileId);
    }

    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, topic, template_id, template_version,
         journey_id, status, created_at, updated_at)
       SELECT $1, x.id, x.idempotency_key, 'email', x.profile_id, 'marketing_email', 'newsletter', x.template_id, 1,
              x.journey_id, x.status, x.created_at, x.updated_at
       FROM jsonb_to_recordset($2::jsonb) AS x(id text, idempotency_key text, profile_id text, template_id text, journey_id text,
              status text, created_at timestamptz, updated_at timestamptz)`,
      [ws, JSON.stringify(rows)],
    );
    await t.srv.events.insertMessageEvents(events);

    for (const w of withdrawn) {
      await owner.call('consent.record', {
        profileId: w.profileId,
        purpose: 'marketing_email',
        channel: 'email',
        status: 'withdrawn',
        source: 'unsubscribe',
        proof: { messageId: w.messageId, via: 'delivery event', issue: opts.number },
      });
      await t.srv.db.admin.query(
        `UPDATE consent_records SET recorded_at = $3
         WHERE id = (SELECT id FROM consent_records
                     WHERE workspace_id = $1 AND profile_id = $2 AND purpose = 'marketing_email' AND source = 'unsubscribe'
                     ORDER BY id DESC LIMIT 1)`,
        [ws, w.profileId, w.at.toISOString()],
      );
    }
    return {
      sent: pool.length,
      delivered,
      opened,
      clicked,
      bounced: bounced.size,
      complained: complained.size,
      unsubscribed: unsubscribed.size,
    };
  }

  const issues = issuePlan(now);
  const sentIssues = new Map<number, { broadcastId: string; templateId: string; sendAt: Date; recipients: string[] }>();

  for (const issue of issues) {
    const short = issue.subject.split(': ').slice(1).join(': ') || 'the weekly issue';
    const template = await owner.call('artifacts.create', {
      type: 'email_template',
      name: `Weekly Signal #${issue.number}`,
      content: {
        purpose: 'marketing_email',
        subject: issue.subject,
        preheader: `Issue ${issue.number} of the MartechSignal weekly`,
        mjml: issueMjml(issue.title, issue.body, `https://martechsignal.example/issues/${issue.number}`, 'Read the issue'),
        sampleData: { profile: { firstName: 'Ada' } },
      },
    });
    await pub(template.artifactId, `Signal #${issue.number} copy`);

    const broadcast = await owner.call('artifacts.create', {
      type: 'broadcast',
      name: `Signal #${issue.number}: ${short}`,
      content: {
        template: template.artifactId,
        segment: subscribers.artifactId,
        sendAt: issue.sendAt.toISOString(),
        description: `The Friday issue, sent to the newsletter list on ${issue.sendAt.toISOString().slice(0, 10)}.`,
      },
    });
    // The run exists before it is published, so the scheduler treats it as history, not a send to do.
    await t.srv.db.admin.query(
      `INSERT INTO broadcast_runs (workspace_id, broadcast_id, version, status, send_at, started_at, finished_at, recipients, queued, created_at)
       VALUES ($1, $2, 1, 'done', $3, $4, $5, 0, 0, $6)
       ON CONFLICT (workspace_id, broadcast_id) DO UPDATE SET status = 'done', send_at = excluded.send_at`,
      [
        ws,
        broadcast.artifactId,
        issue.sendAt.toISOString(),
        addMinutes(issue.sendAt, 1).toISOString(),
        addMinutes(issue.sendAt, 40).toISOString(),
        addMinutes(issue.sendAt, -5).toISOString(),
      ],
    );
    await pub(broadcast.artifactId, `Sent issue #${issue.number}`);

    const recipients = audience.filter((id) => !blocked.has(id));
    const result = await writeIssue({
      number: issue.number,
      templateId: template.artifactId,
      broadcastId: broadcast.artifactId,
      sendAt: issue.sendAt,
      recipients,
      open: issue.open,
      click: issue.click,
      bounce: issue.bounce,
      complaint: issue.complaint,
      unsub: issue.unsub,
    });
    await t.srv.db.admin.query(
      `UPDATE broadcast_runs SET recipients = $3, queued = $4, skipped = $5 WHERE workspace_id = $1 AND broadcast_id = $2`,
      [ws, broadcast.artifactId, result.sent, result.sent, recipients.length - result.sent],
    );
    sentIssues.set(issue.number, { broadcastId: broadcast.artifactId, templateId: template.artifactId, sendAt: issue.sendAt, recipients });

    // The four newest issues belong to Hermes, so its report and the comparison card have outcomes.
    if (issue.agent) await owner.call('artifacts.setOwner', { artifactId: broadcast.artifactId, ownerAgentId: hermesId });
  }

  // A stopped staged send: the canary went out, the complaint rate stopped the rest.
  const stoppedTemplate = await owner.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly Signal #32',
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #32: the vendor shortlist',
      mjml: issueMjml(
        'Signal #32',
        'Nine vendors, three budgets and one very long procurement call.',
        'https://martechsignal.example/issues/32',
        'Read the issue',
      ),
    },
  });
  await pub(stoppedTemplate.artifactId, 'Signal #32 copy');
  const stoppedBroadcast = await owner.call('artifacts.create', {
    type: 'broadcast',
    name: 'Signal #32: the vendor shortlist',
    content: {
      template: stoppedTemplate.artifactId,
      segment: subscribers.artifactId,
      sendAt: addDays(now, -24).toISOString(),
      stagedSend: {
        canaryPercent: 20,
        wait: 'PT2H',
        minCanary: 20,
        maxBounceRate: 0.03,
        maxComplaintRate: 0.003,
        maxUnsubscribeRate: 0.01,
      },
    },
  });
  await t.srv.db.admin.query(
    `INSERT INTO broadcast_runs (workspace_id, broadcast_id, version, status, send_at, started_at, finished_at, recipients, queued, error, created_at)
     VALUES ($1, $2, 1, 'stopped', $3, $4, $5, 0, 0, $6, $3::timestamptz - interval '5 minutes')
     ON CONFLICT (workspace_id, broadcast_id) DO UPDATE SET status = 'stopped', error = excluded.error`,
    [
      ws,
      stoppedBroadcast.artifactId,
      addDays(now, -24).toISOString(),
      addDays(now, -24).toISOString(),
      addDays(now, -24).toISOString(),
      'Stopped at the canary check: complaint rate 2.2% over the canary (stop at 0.3%).',
    ],
  );
  await pub(stoppedBroadcast.artifactId, 'A staged send that the canary stopped');
  const canary = shuffled(
    audience.filter((id) => !blocked.has(id)),
    rng,
  ).slice(0, Math.max(20, Math.floor(audience.length * 0.2)));
  const stoppedResult = await writeIssue({
    number: 32,
    templateId: stoppedTemplate.artifactId,
    broadcastId: stoppedBroadcast.artifactId,
    sendAt: addDays(now, -24),
    recipients: canary,
    open: 0.43,
    click: 0.08,
    bounce: 2,
    complaint: 2,
    unsub: 1,
  });
  await t.srv.db.admin.query(`UPDATE broadcast_runs SET recipients = $3, queued = $4 WHERE workspace_id = $1 AND broadcast_id = $2`, [
    ws,
    stoppedBroadcast.artifactId,
    stoppedResult.sent,
    stoppedResult.sent,
  ]);
  await t.srv.db.admin.query(
    `INSERT INTO broadcast_stages (workspace_id, broadcast_id, stage, canary_percent, check_at, checked_at, canary_recipients, canary_queued,
       sent, bounced, complained, unsubscribed, bounce_rate, complaint_rate, unsubscribe_rate, stop_reason, stopped_at)
     VALUES ($1, $2, 'stopped', 20, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $4)
     ON CONFLICT (workspace_id, broadcast_id) DO NOTHING`,
    [
      ws,
      stoppedBroadcast.artifactId,
      addHours(now, -22).toISOString(),
      addHours(now, -20).toISOString(),
      stoppedResult.sent,
      stoppedResult.sent,
      stoppedResult.bounced,
      stoppedResult.complained,
      stoppedResult.unsubscribed,
      stoppedResult.bounced / Math.max(stoppedResult.sent, 1),
      stoppedResult.complained / Math.max(stoppedResult.sent, 1),
      stoppedResult.unsubscribed / Math.max(stoppedResult.sent, 1),
      'complaint rate 2.2% over the canary (stop at 0.3%)',
    ],
  );

  // One send scheduled for the future.
  const nextIssue = 45;
  const scheduledTemplate = await owner.call('artifacts.create', {
    type: 'email_template',
    name: `Weekly Signal #${nextIssue}`,
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #45: what 40 issues taught us',
      mjml: issueMjml(
        'Signal #45',
        'The patterns that held, the advice that did not, and what we will try next quarter.',
        'https://martechsignal.example/issues/45',
        'Read the issue',
      ),
    },
  });
  await pub(scheduledTemplate.artifactId, 'Next Friday');
  const scheduledBroadcast = await owner.call('artifacts.create', {
    type: 'broadcast',
    name: `Signal #${nextIssue}: what 40 issues taught us`,
    content: { template: scheduledTemplate.artifactId, segment: subscribers.artifactId, sendAt: addDays(now, 10).toISOString() },
  });
  await t.srv.db.admin.query(
    `INSERT INTO broadcast_runs (workspace_id, broadcast_id, version, status, send_at, created_at)
     VALUES ($1, $2, 1, 'scheduled', $3, $4)
     ON CONFLICT (workspace_id, broadcast_id) DO NOTHING`,
    [ws, scheduledBroadcast.artifactId, addDays(now, 10).toISOString(), addDays(now, -1).toISOString()],
  );
  await pub(scheduledBroadcast.artifactId, 'Scheduled for next Friday');

  // Campaign and conversions: two of the newest issues, one UTM campaign, one goal.
  const meta = await owner.call('connections.create', {
    connector: 'meta_ads',
    name: 'Meta ads (demo)',
    settings: { pixelId: '1234567890' },
    secrets: { accessToken: 'demo-token-not-real-1234567890' },
  });
  const conversionMap = await owner.call('artifacts.create', {
    type: 'conversion_map',
    name: 'Newsletter signups',
    content: {
      rules: [{ event: 'Newsletter Signup', value: 'value', currency: 'DKK', meta: { connection: meta.id, eventName: 'Lead' } }],
    },
  });
  await pub(conversionMap.artifactId, 'Count newsletter signups as conversions');

  const campaign = await owner.call('artifacts.create', {
    type: 'campaign',
    name: 'Signal autumn 2026',
    content: {
      description: 'The two October issues, measured on newsletter signups.',
      utmCampaign: 'signal-autumn-2026',
      startsAt: sentIssues.get(39)!.sendAt.toISOString(),
      goal: { kind: 'conversion', event: 'Newsletter Signup', attributionDays: 7 },
      members: [
        { artifactId: sentIssues.get(39)!.broadcastId, role: 'primary' },
        { artifactId: sentIssues.get(40)!.broadcastId, role: 'primary' },
        { artifactId: sentIssues.get(40)!.templateId, role: 'content' },
      ],
    },
  });
  await pub(campaign.artifactId, 'Measure the autumn campaign');

  const conversions: BusEvent[] = [];
  const convert = (profileId: string, at: Date, value: number) => {
    const timestamp = recentMinutes(at).toISOString();
    conversions.push({
      workspaceId: ws,
      sourceId: 'seed-conversions',
      messageId: `conv_${hashId(`${profileId}:${timestamp}`)}`,
      type: 'track',
      name: 'Newsletter Signup',
      anonymousId: `anon-${hashId(profileId)}`,
      userId: '',
      profileId,
      timestamp,
      receivedAt: timestamp,
      properties: { value, currency: 'DKK', utm_campaign: 'signal-autumn-2026', utm_source: 'newsletter', utm_medium: 'email' },
      traits: {},
      piiTraits: {},
      context: {},
      consent: {},
    });
  };
  for (const [n, count] of [
    [39, 30],
    [40, 42],
  ] as const) {
    const issue = sentIssues.get(n)!;
    const recipients = issue.recipients.filter((id) => !blocked.has(id)).slice(0, count);
    for (const [i, profileId] of recipients.entries()) convert(profileId, addDays(issue.sendAt, 1 + (i % 5)), i % 4 === 0 ? 99 : 49);
  }
  // A few conversions from the older issues, so the analytics trend has more than one spike.
  for (const n of [37, 38]) {
    const issue = sentIssues.get(n)!;
    for (const [i, profileId] of issue.recipients.slice(0, 9).entries()) convert(profileId, addDays(issue.sendAt, 1 + (i % 4)), 49);
  }
  await t.srv.events.insert(conversions);

  // A live journey with people spread across its steps.
  const journeyTemplate = await owner.call('artifacts.create', {
    type: 'email_template',
    name: 'Reader onboarding: welcome',
    content: {
      purpose: 'marketing_email',
      subject: 'Welcome to MartechSignal, {{ profile.firstName | default: "reader" }}',
      mjml: issueMjml(
        'Welcome aboard',
        'Every Friday: one idea, one tool and one number worth knowing.',
        'https://martechsignal.example/latest',
        'Read the latest issue',
      ),
    },
  });
  await pub(journeyTemplate.artifactId, 'Onboarding welcome');
  const onboarding = await owner.call('artifacts.create', {
    type: 'journey',
    name: 'Reader onboarding',
    content: {
      purpose: 'marketing_email',
      goal: 'Readers open two issues in their first two weeks',
      nodes: [
        {
          id: 'n1',
          kind: 'trigger',
          label: 'Confirmed subscription',
          config: { event: 'Subscription Confirmed', reentry: 'once' },
          next: [{ to: 'n2' }],
        },
        { id: 'n2', kind: 'email', label: 'Welcome e-mail', config: { template: journeyTemplate.artifactId }, next: [{ to: 'n3' }] },
        { id: 'n3', kind: 'wait', label: 'Wait two days', config: { duration: 'P2D' }, next: [{ to: 'n4' }] },
        {
          id: 'n4',
          kind: 'branch',
          label: 'Opened the welcome?',
          config: { segment: engaged.artifactId },
          next: [{ to: 'n5' }, { to: 'n6' }],
        },
        { id: 'n5', kind: 'goal', label: 'Opened two issues', config: { event: 'Email Opened', within: 'P14D' }, next: [{ to: 'n7' }] },
        { id: 'n6', kind: 'email', label: 'Best of MartechSignal', config: { template: journeyTemplate.artifactId }, next: [{ to: 'n7' }] },
        { id: 'n7', kind: 'exit', label: 'Done', config: {} },
        { id: 'n8', kind: 'exit', label: 'Left the series', config: {} },
      ],
    },
  });
  await pub(onboarding.artifactId, 'Reader onboarding, live');

  const participantPool = shuffled(
    audience.filter((id) => !blocked.has(id)),
    rng,
  ).slice(0, 120);
  const participantRows = participantPool.map((profileId, i) => {
    const enteredAt = addDays(now, -(1 + (i % 27)));
    const completed = i < 45;
    const exited = i >= 45 && i < 65;
    const waiting = i >= 65 && i < 95;
    const failed = i >= 110;
    const converted = completed && i < 30;
    const status = completed ? 'completed' : exited ? 'exited' : waiting ? 'waiting' : failed ? 'failed' : 'ready';
    const node = completed ? 'n7' : exited ? 'n8' : waiting ? 'n3' : failed ? 'n6' : 'n2';
    const seq = completed ? 6 : exited ? 4 : waiting ? 3 : failed ? 4 : 1;
    return {
      profile_id: profileId,
      entry_key: `${onboarding.artifactId}:${profileId}`,
      node,
      status,
      seq,
      due_at: null,
      waiting_event: null,
      waiting_until: null,
      matched: completed && converted,
      converted,
      context: {},
      error: failed ? 'template_render_failed: the block referenced a missing asset' : null,
      entered_at: enteredAt.toISOString(),
      updated_at: recentMinutes(addDays(enteredAt, completed ? 4 : exited ? 2 : waiting ? 2 : 0.2)).toISOString(),
    };
  });
  const insertedParticipants = await t.srv.db.admin.query<{ id: string; profile_id: string }>(
    `INSERT INTO journey_participants (workspace_id, journey_id, version, profile_id, entry_key, node, status, seq, due_at,
       waiting_event, waiting_until, matched, converted, context, error, entered_at, updated_at)
     SELECT $1, $2, 1, x.profile_id, x.entry_key, x.node, x.status, x.seq, x.due_at, x.waiting_event, x.waiting_until,
            x.matched, x.converted, x.context, x.error, x.entered_at, x.updated_at
     FROM jsonb_to_recordset($3::jsonb) AS x(profile_id text, entry_key text, node text, status text, seq int, due_at timestamptz,
            waiting_event text, waiting_until timestamptz, matched boolean, converted boolean, context jsonb, error text,
            entered_at timestamptz, updated_at timestamptz)
     RETURNING id::text, profile_id`,
    [ws, onboarding.artifactId, JSON.stringify(participantRows)],
  );
  const participantOf = new Map(insertedParticipants.rows.map((r) => [r.profile_id, Number(r.id)]));
  const journeyEvents: JourneyEvent[] = [];
  const addJourneyEvent = (profileId: string, type: JourneyEvent['type'], node: string, seq: number, at: Date, detail = '') => {
    const participantId = participantOf.get(profileId);
    if (!participantId) return;
    journeyEvents.push({
      workspaceId: ws,
      journeyId: onboarding.artifactId,
      version: 1,
      participantId,
      profileId,
      node,
      type,
      seq,
      at: recentMinutes(at).toISOString(),
      detail,
    });
  };
  participantRows.forEach((row, i) => {
    const enteredAt = new Date(row.entered_at);
    const profileId = row.profile_id;
    const completed = i < 45;
    const exited = i >= 45 && i < 65;
    const waiting = i >= 65 && i < 95;
    const failed = i >= 110;
    const converted = completed && i < 30;
    addJourneyEvent(profileId, 'entered', 'n1', 0, enteredAt);
    addJourneyEvent(profileId, 'step', 'n2', 1, addMinutes(enteredAt, 5));
    if (waiting || completed || exited || failed) addJourneyEvent(profileId, 'step', 'n3', 2, addDays(enteredAt, 2));
    if (waiting) addJourneyEvent(profileId, 'waiting', 'n3', 3, addDays(enteredAt, 2));
    if (completed || exited || failed) addJourneyEvent(profileId, 'step', 'n4', 3, addDays(enteredAt, 2.1));
    if (completed) {
      addJourneyEvent(profileId, 'step', 'n5', 4, addDays(enteredAt, 3));
      if (converted) addJourneyEvent(profileId, 'converted', 'n5', 5, addDays(enteredAt, 3.2));
      addJourneyEvent(profileId, 'completed', 'n7', 6, addDays(enteredAt, 4));
    }
    if (exited) addJourneyEvent(profileId, 'exited', 'n8', 4, addDays(enteredAt, 2.5), 'refused: marketing_email withdrawn');
    if (failed) addJourneyEvent(profileId, 'failed', 'n6', 4, addDays(enteredAt, 2.5), row.error ?? 'step failed');
  });
  await t.srv.events.insertJourneyEvents(journeyEvents);

  // A web experience with exposures and conversions.
  const experience = await owner.call('artifacts.create', {
    type: 'experience',
    name: 'Newsletter banner: autumn test',
    content: {
      placement: 'article-footer',
      description: 'Two pitches for the Friday newsletter.',
      goal: { event: 'Newsletter Signup' },
      holdoutPercent: 10,
      variants: [
        {
          id: 'a',
          name: 'Short pitch',
          weight: 50,
          content: { html: '<p><strong>Get the Friday signal.</strong> One idea, one tool, one number.</p>' },
        },
        {
          id: 'b',
          name: 'Numbered pitch',
          weight: 50,
          content: { html: '<p><strong>3 things worth your inbox this Friday.</strong> Join 12,000 readers.</p>' },
        },
      ],
    },
  });
  await pub(experience.artifactId, 'Autumn banner test');

  const experienceEvents: BusEvent[] = [];
  const experienceEvent = (name: string, anonymousId: string, at: Date, properties: Record<string, unknown>) => {
    const timestamp = recentMinutes(at).toISOString();
    experienceEvents.push({
      workspaceId: ws,
      sourceId: 'seed-experience',
      messageId: `exp_${hashId(`${name}:${anonymousId}:${timestamp}`)}`,
      type: 'track',
      name,
      anonymousId,
      userId: '',
      timestamp,
      receivedAt: timestamp,
      properties,
      traits: {},
      piiTraits: {},
      context: {},
      consent: {},
    });
  };
  const exposurePlan: [variant: string, exposed: number, converted: number][] = [
    ['a', 300, 42],
    ['b', 200, 18],
    ['holdout', 40, 3],
  ];
  let visitor = 0;
  for (const [variant, exposed, converted] of exposurePlan) {
    for (let i = 0; i < exposed; i++) {
      const anonymousId = `anon-seed-visitor-${++visitor}`;
      const exposedAt = addDays(now, -(1 + (i % 24)));
      experienceEvent('Experience Viewed', anonymousId, exposedAt, {
        experience_id: experience.artifactId,
        variant_id: variant,
        version: 1,
        placement: 'article-footer',
      });
      if (i < converted)
        experienceEvent('Newsletter Signup', anonymousId, addDays(exposedAt, 0.2 + (i % 4) * 0.4), {
          experience_id: experience.artifactId,
          variant_id: variant,
          utm_campaign: 'signal-autumn-2026',
          value: 49,
        });
    }
  }
  await t.srv.events.insert(experienceEvents);

  // A hosted agent beside Hermes, with a few recorded runs and AI usage for the comparison card.
  const hosted = await owner.call('agents.createHosted', {
    name: 'Signal analyst',
    description: 'Reads the weekly numbers and drafts the editorial note.',
    instructions: 'Read last week’s message activity, summarise the strongest and weakest issues, and draft a short note for the editor.',
    schedule: 'weekly:mon:07:00',
    scopes: ['artifacts:read', 'audit:read'],
    maxTokensPerRun: 20_000,
    maxToolCallsPerRun: 15,
  });
  const hostedAgentId = hosted.agentId;

  // A mandate with goals, so agents.report and the comparison card have something to measure.
  await owner.call('workspace.setAutonomy', {
    maxLevel: { draft: 3, 'content.publish': 3, 'send.broadcast': 3, 'send.direct': 2, 'journey.live': 2 },
  });
  const mandate = await owner.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Hermes newsletter mandate',
    content: {
      agent: hermesId,
      purpose: 'Draft, send and report the weekly MartechSignal issue to the newsletter list.',
      validUntil: addDays(now, 120).toISOString(),
      goals: [
        { measure: 'email.click_rate', target: 0.12, direction: 'up' as const },
        { measure: 'email.open_rate', target: 0.45, direction: 'up' as const },
        { measure: 'email.unsubscribe_rate', target: 0.01, direction: 'down' as const },
      ],
      scope: { segments: [subscribers.artifactId], purposes: ['marketing_email'], channels: ['email'] },
      levels: { draft: 3, 'content.publish': 3, 'send.broadcast': 3 },
      limits: { recipientsPerSend: 600, sendsPerDay: 3 },
      guardrails: { unsubscribeRate: 0.01, complaintRate: 0.003, bounceRate: 0.05, window: 'P7D', minSent: 100 },
      escalation: { userIds: [users.owner.id] },
    },
  });
  await owner.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'The weekly newsletter mandate' });

  // The ledger rows the command path would have written, backdated across the past weeks.
  const actionRows: Record<string, unknown>[] = [];
  const action = (opts: {
    agentId?: string;
    daysAgo: number;
    command: string;
    actionClass: string;
    decision: 'allow' | 'hold' | 'ask' | 'deny';
    ok?: boolean;
    target?: string;
    intent?: string;
    impact?: Record<string, unknown>;
    undone?: boolean;
  }) => {
    actionRows.push({
      agent_id: opts.agentId ?? hermesId,
      command: opts.command,
      action_class: opts.actionClass,
      decision: opts.decision,
      ok: opts.ok ?? opts.decision !== 'deny',
      target: opts.target ?? null,
      intent: opts.intent ?? null,
      impact: opts.impact ?? {},
      mandate_id: (opts.agentId ?? hermesId) === hermesId ? mandate.artifactId : null,
      mandate_version: (opts.agentId ?? hermesId) === hermesId ? 1 : null,
      level: (opts.agentId ?? hermesId) === hermesId ? 3 : null,
      surface: 'seed',
      at: addDays(now, -opts.daysAgo).toISOString(),
      undone_at: opts.undone ? addDays(now, -(opts.daysAgo - 0.3)).toISOString() : null,
      undone_by: opts.undone ? PEOPLE.owner.name : null,
      undo_result: opts.undone ? 'Restored the previous version.' : null,
      undo: opts.undone ? { kind: 'republish', artifactId: opts.target, previousVersion: 1 } : null,
    });
  };
  const issue40 = sentIssues.get(40)!;
  const issue39 = sentIssues.get(39)!;
  const issue38 = sentIssues.get(38)!;
  const issue37 = sentIssues.get(37)!;
  action({
    daysAgo: 23,
    command: 'artifacts.requestPublish',
    actionClass: 'draft',
    decision: 'allow',
    target: issue37.templateId,
    intent: 'Draft issue 37',
  });
  action({
    daysAgo: 22,
    command: 'artifacts.requestPublish',
    actionClass: 'content.publish',
    decision: 'allow',
    target: issue37.templateId,
    intent: 'Publish issue 37 copy',
  });
  action({
    daysAgo: 22,
    command: 'artifacts.requestPublish',
    actionClass: 'send.broadcast',
    decision: 'allow',
    target: issue37.broadcastId,
    intent: 'Send issue 37',
    impact: { people: issue37.recipients.length },
  });
  action({
    daysAgo: 20,
    command: 'artifacts.requestPublish',
    actionClass: 'draft',
    decision: 'allow',
    target: issue38.templateId,
    intent: 'Draft issue 38',
    undone: true,
  });
  action({
    daysAgo: 15,
    command: 'artifacts.requestPublish',
    actionClass: 'send.broadcast',
    decision: 'allow',
    target: issue38.broadcastId,
    intent: 'Send issue 38',
    impact: { people: issue38.recipients.length },
  });
  action({
    daysAgo: 12,
    command: 'artifacts.updateDraft',
    actionClass: 'draft',
    decision: 'allow',
    target: engaged.artifactId,
    intent: 'Tighten the engaged segment',
  });
  action({
    daysAgo: 10,
    command: 'artifacts.requestPublish',
    actionClass: 'send.broadcast',
    decision: 'hold',
    target: issue39.broadcastId,
    intent: 'Send issue 39',
    impact: { people: issue39.recipients.length },
  });
  action({
    daysAgo: 10,
    command: 'artifacts.requestPublish',
    actionClass: 'send.broadcast',
    decision: 'allow',
    target: issue39.broadcastId,
    intent: 'Send issue 39 after the veto window',
    impact: { people: issue39.recipients.length },
  });
  action({
    daysAgo: 8,
    command: 'segments.preview',
    actionClass: 'draft',
    decision: 'allow',
    target: subscribers.artifactId,
    intent: 'Preview the newsletter audience',
  });
  action({
    daysAgo: 6,
    command: 'artifacts.requestPublish',
    actionClass: 'send.broadcast',
    decision: 'ask',
    target: issue40.broadcastId,
    intent: 'Send issue 40',
    impact: { people: issue40.recipients.length },
  });
  action({
    daysAgo: 5,
    command: 'artifacts.requestPublish',
    actionClass: 'send.broadcast',
    decision: 'allow',
    target: issue40.broadcastId,
    intent: 'Send issue 40',
    impact: { people: issue40.recipients.length },
  });
  action({
    daysAgo: 4,
    command: 'artifacts.updateDraft',
    actionClass: 'draft',
    decision: 'deny',
    ok: false,
    target: form.artifactId,
    intent: 'Change the consent copy',
  });
  action({
    daysAgo: 3,
    command: 'artifacts.requestPublish',
    actionClass: 'content.publish',
    decision: 'deny',
    ok: false,
    target: issue40.templateId,
    intent: 'Republish a superseded version',
  });
  action({
    daysAgo: 2,
    command: 'learnings.add',
    actionClass: 'draft',
    decision: 'allow',
    target: experience.artifactId,
    intent: 'Record the banner result',
  });

  action({
    agentId: hostedAgentId,
    daysAgo: 21,
    command: 'analytics.query',
    actionClass: 'draft',
    decision: 'allow',
    target: undefined,
    intent: 'Weekly numbers',
  });
  action({
    agentId: hostedAgentId,
    daysAgo: 14,
    command: 'analytics.query',
    actionClass: 'draft',
    decision: 'allow',
    target: undefined,
    intent: 'Weekly numbers',
  });
  action({
    agentId: hostedAgentId,
    daysAgo: 7,
    command: 'analytics.query',
    actionClass: 'draft',
    decision: 'allow',
    target: undefined,
    intent: 'Weekly numbers',
  });
  action({
    agentId: hostedAgentId,
    daysAgo: 3,
    command: 'artifacts.updateDraft',
    actionClass: 'draft',
    decision: 'ask',
    target: issue40.templateId,
    intent: 'Draft the editorial note',
  });

  await t.srv.db.admin.query(
    `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, reasons, impact, ok, target, surface,
       mandate_id, mandate_version, intent, level, undo, undone_at, undone_by, undo_result, at)
     SELECT $1, x.agent_id, x.command, x.action_class, x.decision, '[]'::jsonb, x.impact, x.ok, x.target, x.surface,
            x.mandate_id, x.mandate_version, x.intent, x.level, x.undo, x.undone_at, x.undone_by, x.undo_result, x.at
     FROM jsonb_to_recordset($2::jsonb) AS x(agent_id text, command text, action_class text, decision text, impact jsonb, ok boolean,
            target text, surface text, mandate_id text, mandate_version int, intent text, level smallint, undo jsonb,
            undone_at timestamptz, undone_by text, undo_result text, at timestamptz)`,
    [ws, JSON.stringify(actionRows)],
  );

  // The guardian capped Hermes once for a loop, and a person cleared it a day later.
  await t.srv.db.admin.query(
    `INSERT INTO guardian_events (workspace_id, id, agent_id, kind, action, reason, evidence, suspended_holds, at, cleared_at, cleared_by, cleared_note)
     VALUES ($1, $2, $3, 'loop', 'cap', $4, $5::jsonb, 0, $6, $7, $8, $9)`,
    [
      ws,
      `gdn_${hashId(`${hermesId}:loop`)}`,
      hermesId,
      'The same broadcast was changed four times in an hour, which looks like a loop.',
      { target: issue39.broadcastId, changes: 4 },
      addDays(now, -16).toISOString(),
      addDays(now, -15).toISOString(),
      PEOPLE.owner.name,
      'Looked at the diffs; the agent was fixing the same typo. Cleared.',
    ],
  );

  // Learnings with the results behind them.
  const personLearning = await owner.call('learnings.add', {
    statement: 'A concrete number in the subject lifts clicks for this audience.',
    scope: { channel: 'email', purpose: 'marketing_email', topic: 'newsletter' },
    evidence: [
      {
        kind: 'subject_test',
        id: issue40.broadcastId,
        summary: 'Numbers beat the plain subjects across four issues',
        numbers: { wins: 3, tests: 4, liftPts: 2.1 },
      },
    ],
  });
  const agentLearning = await agent.call('learnings.add', {
    statement: 'The numbered banner beats the short pitch on newsletter signups.',
    scope: { channel: 'email' },
    evidence: [
      {
        kind: 'experience',
        id: experience.artifactId,
        summary: 'Variant B converted at a higher rate in the autumn test',
        numbers: { exposedA: 300, exposedB: 200, conversionsA: 42, conversionsB: 18 },
      },
    ],
  });
  await t.srv.db.admin.query(`UPDATE learnings SET created_at = $3::timestamptz WHERE workspace_id = $1 AND id = ANY($2::text[])`, [
    ws,
    [personLearning.id, agentLearning.id],
    addDays(now, -9).toISOString(),
  ]);

  // AI usage for the hosted agent, so the comparison card shows calls and cost.
  await t.srv.db.admin.query(
    `INSERT INTO ai_calls (workspace_id, id, kind, status, model, input, input_tokens, output_tokens, principal_id, created_at, finished_at)
     SELECT $1, 'aic_' || x.n, 'hosted', 'done', 'claude-sonnet-4-5', jsonb_build_object('hostedAgentId', $2::text),
            x.input_tokens, x.output_tokens, $2::text, x.at, x.at
     FROM jsonb_to_recordset($3::jsonb) AS x(n text, input_tokens int, output_tokens int, at timestamptz)`,
    [
      ws,
      hostedAgentId,
      JSON.stringify([
        { n: hashId('hosted-1'), input_tokens: 8200, output_tokens: 1400, at: addDays(now, -21).toISOString() },
        { n: hashId('hosted-2'), input_tokens: 7600, output_tokens: 1250, at: addDays(now, -14).toISOString() },
        { n: hashId('hosted-3'), input_tokens: 9100, output_tokens: 1600, at: addDays(now, -7).toISOString() },
      ]),
    ],
  );

  // Alerts: rules that fired and recovered, with the history a person would see.
  const ownerUserId = users.owner.id;
  const alertChannel = [{ type: 'email' as const, userIds: [ownerUserId] }];
  const bounceAlert = await owner.call('alerts.create', {
    name: 'Bounce ceiling',
    kind: 'deliverability',
    config: { metric: 'bounce', window: 'P1D', threshold: 0.06, minSent: 200 },
    channels: alertChannel,
  });
  const complaintAlert = await owner.call('alerts.create', {
    name: 'Complaint watch',
    kind: 'deliverability',
    config: { metric: 'complaint', window: 'P7D', threshold: 0.002, minSent: 200 },
    channels: alertChannel,
  });
  const journeyAlert = await owner.call('alerts.create', {
    name: 'Journey errors',
    kind: 'journey_errors',
    config: { window: 'PT1H', threshold: 5 },
    channels: alertChannel,
  });
  await t.srv.db.admin.query(
    `INSERT INTO alert_events (workspace_id, id, rule_id, state, value, threshold, "window", fired_at, resolved_at, notified)
     SELECT $1, x.id, x.rule_id, 'resolved', x.value, x.threshold, x."window", x.fired_at, x.resolved_at, '[]'::jsonb
     FROM jsonb_to_recordset($2::jsonb) AS x(id text, rule_id text, value double precision, threshold double precision, "window" text,
            fired_at timestamptz, resolved_at timestamptz)`,
    [
      ws,
      JSON.stringify([
        {
          id: `ale_${hashId('bounce-firing')}`,
          rule_id: bounceAlert.rule.id,
          value: 0.071,
          threshold: 0.06,
          window: 'P1D',
          fired_at: addDays(now, -12).toISOString(),
          resolved_at: addDays(now, -11).toISOString(),
        },
        {
          id: `ale_${hashId('complaint-firing')}`,
          rule_id: complaintAlert.rule.id,
          value: 0.0042,
          threshold: 0.002,
          window: 'P7D',
          fired_at: addDays(now, -5).toISOString(),
          resolved_at: addDays(now, -4).toISOString(),
        },
        {
          id: `ale_${hashId('journey-firing')}`,
          rule_id: journeyAlert.rule.id,
          value: 7,
          threshold: 5,
          window: 'PT1H',
          fired_at: addDays(now, -3).toISOString(),
          resolved_at: addDays(now, -3).toISOString(),
        },
      ]),
    ],
  );

  // An import-history entry: a static VIP list loaded from a CSV.
  const vipSegment = await owner.call('artifacts.create', {
    type: 'segment',
    name: 'VIP readers',
    content: { mode: 'static', description: 'Names the editor wants to hear from first.' },
  });
  await pub(vipSegment.artifactId, 'VIP list');
  const vipEmails = people.slice(0, 12).map((p) => p.email);
  const vipImport = await owner.call('audiences.import', {
    segmentId: vipSegment.artifactId,
    csv: ['email', ...vipEmails].join('\n'),
    column: 'email',
    idType: 'email',
    fileName: 'vip-readers-2026-10.csv',
  });
  if (vipImport.importId)
    await t.srv.db.admin.query(`UPDATE segment_list_imports SET created_at = $3 WHERE workspace_id = $1 AND id = $2`, [
      ws,
      vipImport.importId,
      addDays(now, -20).toISOString(),
    ]);

  // Make the people page look lived-in: activity times spread across the past month.
  const lastSeen = new Map<string, Date>();
  for (const profileId of audience) lastSeen.set(profileId, addDays(now, -(1 + (Number.parseInt(hashId(profileId).slice(0, 4), 16) % 25))));
  await t.srv.db.admin.query(
    `UPDATE profiles p SET first_seen = x.first_seen, last_seen = x.last_seen, created_at = x.first_seen, updated_at = x.last_seen
     FROM jsonb_to_recordset($2::jsonb) AS x(id text, first_seen timestamptz, last_seen timestamptz)
     WHERE p.workspace_id = $1 AND p.id = x.id`,
    [
      ws,
      JSON.stringify(
        [...lastSeen.entries()].map(([id, seen]) => ({
          id,
          first_seen: addDays(seen, -30 - (Number.parseInt(hashId(id).slice(4, 8), 16) % 300)).toISOString(),
          last_seen: seen.toISOString(),
        })),
      ),
    ],
  );

  return {
    ws,
    sandbox,
    users,
    token: token.token,
    forms: { signup: form.artifactId, footer: footerForm.artifactId },
    archive: { slug: 'martechsignal', issueUrl: archivedIssue?.url ?? '' },
    demo: {
      broadcasts: [...sentIssues.values()].map((i) => i.broadcastId),
      campaign: campaign.artifactId,
      experience: experience.artifactId,
      journey: onboarding.artifactId,
      vipSegment: vipSegment.artifactId,
      agents: { hermes: hermesId, hosted: hostedAgentId },
      people: people.length,
    },
  };
}
