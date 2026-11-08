import type { Out } from '../../../app/api';
import { ApiError } from '../../../app/api';
import { ANALYTICS_MEASURES, measureUnit } from '../../../lib/labels';
import {
  DEMO_ARTIFACTS,
  DEMO_MEMBERS,
  DEMO_NOW,
  DEMO_PENDING_APPROVALS,
  DEMO_PEOPLE,
  DEMO_TIME_ZONE,
  DEMO_USER,
  DEMO_WORKSPACE,
  DEMO_WORKSPACE_ID,
  demoId,
} from '../integration/demo';

// The demo destinations' fixture projection (#530). #524 supplied the bounded artifact/approval
// projection; this file adds the people, purposes, metrics, agent, alert, broadcast and artifact
// content the real pages read. Everything is plain data derived from the deterministic e2e seed:
// no server module, no DB, no network, no clock. Task D maps the remaining read commands onto it in
// `reads.ts`; anything not listed there is explicitly unavailable.

type ProfileRow = Out<'profiles.list'>['profiles'][number];
type PersonProfile = Out<'profiles.get'>;
type Purpose = Out<'purposes.list'>['purposes'][number];
type Message = Out<'messages.list'>['messages'][number];
type PersonEvent = Out<'profiles.events'>['events'][number];
type ConsentRecord = Out<'consent.history'>['records'][number];
type ArtifactRow = Out<'artifacts.list'>['artifacts'][number];
type Artifact = Out<'artifacts.get'>;
type Agent = Out<'agents.list'>['agents'][number];
type AlertRule = Out<'alerts.list'>['rules'][number];
type Broadcast = Out<'broadcasts.list'>['broadcasts'][number];

const OWNER_AT = '2026-09-01T08:00:00.000Z';
const AUTHOR = { type: 'user' as const, id: DEMO_USER.id, client: null };
const AGENT_AUTHOR = { type: 'agent' as const, id: '00000000-0000-4000-8000-00000000e1e2', client: 'Hermes' };
const PERSON_REQUESTER = {
  kind: 'person' as const,
  displayName: 'Sam Rivera',
  personName: 'Sam Rivera',
  tokenName: null,
  tokenId: null,
  clientName: null,
};

/** A deterministic day offset before `DEMO_NOW`, so every fixture timestamp is stable. */
const daysBefore = (days: number, hour = 9) => {
  const date = new Date(Date.parse(DEMO_NOW) - days * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

export const DEMO_ARTIFACT_CONTENT: Record<string, unknown> = {
  Brand: {
    siteName: 'MartechSignal',
    siteUrl: 'https://martechsignal.example',
    logoUrl: null,
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
  Purposes: {
    purposes: [
      {
        key: 'necessary',
        name: 'Strictly necessary',
        description: 'Running the site and service you asked for.',
        basis: 'contract',
        channels: ['web'],
        requiresDoubleOptIn: false,
        topics: [],
      },
      {
        key: 'analytics',
        name: 'Analytics',
        description: 'Understanding how the site is used.',
        basis: 'consent',
        channels: ['web'],
        requiresDoubleOptIn: false,
        topics: [],
      },
      {
        key: 'web_personalization',
        name: 'Personalization',
        description: 'Tailoring the site to you.',
        basis: 'consent',
        channels: ['web'],
        requiresDoubleOptIn: false,
        topics: [],
      },
      {
        key: 'onboarding',
        name: 'Service messages',
        description: 'Messages about your account and orders.',
        basis: 'contract',
        channels: ['email'],
        requiresDoubleOptIn: false,
        topics: [],
      },
      {
        key: 'marketing_email',
        name: 'Marketing e-mail',
        description: 'News and offers by e-mail.',
        basis: 'consent',
        channels: ['email'],
        requiresDoubleOptIn: false,
        topics: [
          { key: 'newsletter', name: 'Weekly newsletter', description: 'The Friday issue', default: 'subscribed' },
          { key: 'product_news', name: 'Product news', description: 'Launches and changes', default: 'unsubscribed' },
        ],
      },
      {
        key: 'marketing_sms',
        name: 'Marketing SMS',
        description: 'News and offers by text message.',
        basis: 'consent',
        channels: ['sms'],
        requiresDoubleOptIn: false,
        topics: [],
      },
    ],
  },
  'Confirm your subscription': {
    purpose: 'onboarding',
    subject: 'Confirm your MartechSignal subscription',
    preheader: 'One click and you are in',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Click below to confirm.</mj-text></mj-column></mj-section></mj-body></mjml>',
    sampleData: { profile: { firstName: 'Ada' }, confirm_url: 'https://links.example/f/confirm/sample' },
  },
  'Weekly Signal #42': {
    purpose: 'marketing_email',
    subject: 'Signal #42: attribution is a story you tell',
    preheader: 'Plus three tools worth a look',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>This week: why last-click attribution keeps winning arguments it should lose.</mj-text></mj-column></mj-section></mj-body></mjml>',
    sampleData: { profile: { firstName: 'Ada' } },
  },
  'Weekly Signal #43': {
    purpose: 'marketing_email',
    subject: 'Signal #43: the small numbers that matter',
    preheader: 'A short read before Friday',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Draft of issue 43.</mj-text></mj-column></mj-section></mj-body></mjml>',
    sampleData: { profile: { firstName: 'Ada' } },
  },
  'Weekly Signal #44': {
    purpose: 'marketing_email',
    subject: 'Signal #44: what we learned this month',
    preheader: 'Next issue, ready for review',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Next issue, ready for review.</mj-text></mj-column></mj-section></mj-body></mjml>',
    sampleData: { profile: { firstName: 'Ada' } },
  },
  'Reader onboarding: welcome': {
    purpose: 'marketing_email',
    subject: 'Welcome to MartechSignal, {{ profile.firstName | default: "reader" }}',
    preheader: 'One idea, one tool and one number',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Welcome aboard.</mj-text></mj-column></mj-section></mj-body></mjml>',
    sampleData: { profile: { firstName: 'Ada' } },
  },
  'Newsletter subscribers': {
    description: 'Everyone who allows the newsletter.',
    condition: { consent: 'marketing_email' },
  },
  'Engaged readers': {
    description: 'Subscribers who opened recently.',
    condition: { all: [{ consent: 'marketing_email' }, { event: 'Email Opened', within: 'P30D' }] },
  },
  'VIP readers': {
    description: 'Readers with at least three orders.',
    condition: { trait: 'orders_count', op: 'gte', value: 3 },
  },
  'Newsletter signup': {
    purposes: ['marketing_email'],
    doubleOptIn: true,
    confirmationTemplate: demoId('eml', 'email_template:Confirm your subscription'),
    consentText: 'Send me the weekly MartechSignal newsletter. Unsubscribe at any time.',
    traits: ['firstName'],
    successUrl: 'https://martechsignal.example/thanks',
    confirmedUrl: 'https://martechsignal.example/welcome',
    allowedOrigins: ['https://martechsignal.example'],
  },
  'Footer signup': {
    purposes: ['marketing_email'],
    doubleOptIn: true,
    confirmationTemplate: demoId('eml', 'email_template:Confirm your subscription'),
    consentText: 'Send me the weekly MartechSignal newsletter. Unsubscribe at any time.',
    traits: [],
    successUrl: 'https://martechsignal.example/thanks',
    allowedOrigins: ['https://martechsignal.example'],
  },
  'Signal #41: the archive issue': {
    templateId: demoId('eml', 'email_template:Weekly Signal #42'),
    segmentId: demoId('seg', 'segment:Newsletter subscribers'),
    purpose: 'marketing_email',
    subject: 'Signal #41: the archive issue',
    preheader: 'Every issue, on the web',
  },
  'Signal #42 resend to engaged readers': {
    templateId: demoId('eml', 'email_template:Weekly Signal #42'),
    segmentId: demoId('seg', 'segment:Engaged readers'),
    purpose: 'marketing_email',
    subject: 'Signal #42: attribution is a story you tell',
    preheader: 'A second look for engaged readers',
  },
  'Signal #32: the vendor shortlist': {
    templateId: demoId('eml', 'email_template:Weekly Signal #42'),
    segmentId: demoId('seg', 'segment:Newsletter subscribers'),
    purpose: 'marketing_email',
    subject: 'Signal #32: the vendor shortlist',
    preheader: 'Three tools worth a look',
  },
  'Welcome series': {
    purpose: 'marketing_email',
    goal: 'Readers open two issues',
    nodes: [
      {
        id: 'w1',
        kind: 'trigger',
        label: 'Confirmed subscription',
        config: { event: 'Subscription Confirmed', reentry: 'once' },
        next: [{ to: 'w2' }],
      },
      {
        id: 'w2',
        kind: 'email',
        label: 'Welcome e-mail',
        config: { template: demoId('eml', 'email_template:Reader onboarding: welcome') },
        next: [{ to: 'w3' }],
      },
      { id: 'w3', kind: 'exit', label: 'Done', config: {} },
    ],
  },
  'Reader onboarding': {
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
      {
        id: 'n2',
        kind: 'email',
        label: 'Welcome e-mail',
        config: { template: demoId('eml', 'email_template:Reader onboarding: welcome') },
        next: [{ to: 'n3' }],
      },
      { id: 'n3', kind: 'wait', label: 'Wait two days', config: { duration: 'P2D' }, next: [{ to: 'n4' }] },
      {
        id: 'n4',
        kind: 'branch',
        label: 'Opened the welcome?',
        config: { segment: demoId('seg', 'segment:Engaged readers') },
        next: [{ to: 'n5' }, { to: 'n6' }],
      },
      { id: 'n5', kind: 'goal', label: 'Opened two issues', config: { event: 'Email Opened', within: 'P14D' }, next: [{ to: 'n7' }] },
      {
        id: 'n6',
        kind: 'email',
        label: 'Best of MartechSignal',
        config: { template: demoId('eml', 'email_template:Reader onboarding: welcome') },
        next: [{ to: 'n7' }],
      },
      { id: 'n7', kind: 'exit', label: 'Done', config: {} },
      { id: 'n8', kind: 'exit', label: 'Left the series', config: {} },
    ],
  },
  'Newsletter banner on articles': {
    placement: 'article_after',
    priority: 100,
    description: 'Weekly newsletter banner under articles.',
    trigger: { type: 'scroll', percent: 50 },
    targeting: 'everyone',
    variants: [
      { id: 'control', name: 'Control', weight: 50, content: { kind: 'html', html: '<p>Read more of the Signal.</p>' } },
      { id: 'test', name: 'Test', weight: 50, content: { kind: 'html', html: '<p>Get the weekly Signal in your inbox.</p>' } },
    ],
    analysis: { method: 'sequential', alpha: 0.05, threshold: 0.95 },
  },
  'Newsletter banner: autumn test': {
    placement: 'article_after',
    priority: 100,
    description: 'Autumn banner copy test.',
    trigger: { type: 'immediate' },
    targeting: 'everyone',
    variants: [
      { id: 'control', name: 'Control', weight: 50, content: { kind: 'html', html: '<p>Read more of the Signal.</p>' } },
      { id: 'test', name: 'Test', weight: 50, content: { kind: 'html', html: '<p>Autumn issue is here.</p>' } },
    ],
    analysis: { method: 'sequential', alpha: 0.05, threshold: 0.95 },
  },
  'Signal autumn 2026': {
    goal: { kind: 'engagement', event: 'Email Clicked', target: 500, attributionDays: 7 },
    members: [demoId('bct', 'broadcast:Signal #41: the archive issue')],
  },
  'Hermes newsletter mandate': {
    version: 1,
    level: 'draft',
    purposes: ['marketing_email'],
    actions: ['draft', 'content.publish'],
  },
  'Signal analyst': {
    system: 'You are a careful marketing analyst. Answer from the provided metrics only.',
    user: 'Summarise the week for the newsletter editor.',
  },
};

const artifactRow = (name: string): ArtifactRow | undefined => DEMO_ARTIFACTS.find((a) => a.name === name);

export function demoContentOf(row: ArtifactRow): unknown {
  return DEMO_ARTIFACT_CONTENT[row.name] ?? {};
}

function demoArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    latestVersion: row.latestVersion,
    publishedVersion: row.publishedVersion,
    ownerAgentId: row.name === 'Weekly Signal #43' ? AGENT_AUTHOR.id : null,
    version: {
      number: row.latestVersion,
      state: row.latestState,
      author: row.latestState === 'draft' ? AGENT_AUTHOR : AUTHOR,
      by: row.latestState === 'draft' ? PERSON_REQUESTER : undefined,
      note: row.latestState === 'draft' ? 'Draft from the editorial outline.' : 'Published sample data.',
      contentHash: `demo-${row.id}`,
      basedOn: row.latestState === 'draft' ? null : row.latestVersion > 1 ? row.latestVersion - 1 : null,
      createdAt: row.updatedAt,
      content: demoContentOf(row),
    },
    layout: null,
    references: [],
  };
}

export function demoArtifactById(id: string): Artifact {
  const row = DEMO_ARTIFACTS.find((a) => a.id === id);
  if (!row) throw new ApiError(404, 'not_found', 'This artifact is not part of the demo sample.');
  return demoArtifact(row);
}

export function demoArtifactHistory(id: string): Out<'artifacts.history'> {
  const artifact = demoArtifactById(id);
  const rows = [];
  for (let number = artifact.latestVersion; number >= 1; number--) {
    const state =
      number === artifact.latestVersion ? artifact.version.state : number === artifact.publishedVersion ? 'published' : 'superseded';
    rows.push({
      number,
      state,
      author: number === artifact.latestVersion ? artifact.version.author : AUTHOR,
      note: state === 'published' ? 'Published sample data.' : null,
      contentHash: `demo-${id}-${number}`,
      basedOn: number > 1 ? number - 1 : null,
      createdAt: artifact.version.createdAt,
    } as Out<'artifacts.history'>['versions'][number]);
  }
  return { versions: rows };
}

export function demoArtifactDiff(id: string): Out<'artifacts.diff'> {
  const artifact = demoArtifactById(id);
  return { from: artifact.publishedVersion, to: artifact.latestVersion, changes: [], layoutOnly: false };
}

/** A pending approval with its consequence payload, for the drawer and consequence summary. */
export function demoApprovalById(id: string): Out<'approvals.get'> {
  const approval = DEMO_PENDING_APPROVALS.find((a) => a.id === id);
  if (!approval) throw new ApiError(404, 'not_found', 'This request is not part of the demo sample.');
  const artifact = demoArtifactById(approval.artifactId);
  return {
    ...approval,
    content: artifact.version.content,
    publishedContent: artifact.publishedVersion !== null ? artifact.version.content : null,
    publishedVersion: artifact.publishedVersion,
    diff: { from: artifact.publishedVersion, to: artifact.latestVersion, changes: [] },
    history: [],
  };
}

// --- People ---------------------------------------------------------------------------------

function lastSeenFor(index: number): string {
  return daysBefore(index % 20, 9);
}

export const DEMO_PROFILE_ROWS: ProfileRow[] = DEMO_PEOPLE.map((person, index) => ({
  id: demoId('prf', person.userId),
  traits: { firstName: person.firstName, lastName: person.lastName, city: person.city },
  known: true,
  lastSeen: lastSeenFor(index),
  firstSeen: OWNER_AT,
  consent: [
    { purpose: 'marketing_email', status: person.consent },
    { purpose: 'analytics', status: 'granted' },
    { purpose: 'web_personalization', status: index % 4 === 0 ? 'denied' : 'granted' },
  ],
  email: person.email,
}));

/** One page of the profile list, with the same `before` + `beforeId` keyset the real list uses. */
export function demoProfileRowsPage(input: { limit?: number; before?: string; beforeId?: string }): Out<'profiles.list'> {
  const limit = Math.max(1, input.limit ?? 50);
  const start = input.beforeId ? Math.max(0, DEMO_PROFILE_ROWS.findIndex((row) => row.id === input.beforeId) + 1) : 0;
  const rows = DEMO_PROFILE_ROWS.slice(start, start + limit);
  const last = rows.at(-1);
  return {
    profiles: rows,
    nextCursor: start + limit < DEMO_PROFILE_ROWS.length && last ? { lastSeen: last.lastSeen, id: last.id } : null,
  };
}

const purposeBasis = new Map(
  ((DEMO_ARTIFACT_CONTENT.Purposes as { purposes: Purpose[] }).purposes ?? []).map((purpose) => [purpose.key, purpose]),
);

export function demoProfile(id: string): PersonProfile {
  const index = DEMO_PROFILE_ROWS.findIndex((row) => row.id === id);
  if (index < 0) throw new ApiError(404, 'not_found', 'This person is not part of the demo sample.');
  const row = DEMO_PROFILE_ROWS[index]!;
  const person = DEMO_PEOPLE[index]!;
  return {
    id: row.id,
    traits: { city: person.city, lifecycle_stage: index % 3 === 0 ? 'engaged' : 'new' },
    personal: { email: person.email, firstName: person.firstName, lastName: person.lastName },
    identifiers: [
      { type: 'email', value: person.email, firstSeen: row.firstSeen, lastSeen: row.lastSeen },
      { type: 'user_id', value: person.userId, firstSeen: row.firstSeen, lastSeen: row.lastSeen },
    ],
    consent: row.consent.map((entry) => ({
      purpose: entry.purpose,
      channel: entry.purpose.includes('email') ? 'email' : 'web',
      status: entry.status ?? 'granted',
      basis: purposeBasis.get(entry.purpose)?.basis ?? 'consent',
      source: 'import',
      updatedAt: row.lastSeen,
    })),
    mergedFrom: [],
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
  };
}

export function demoProfileEvents(profileId: string): Out<'profiles.events'> {
  const profile = DEMO_PROFILE_ROWS.find((row) => row.id === profileId);
  if (!profile) return { events: [], nextCursor: null };
  const events: PersonEvent[] = [
    {
      eventId: demoId('evt', `${profileId}:opened`),
      type: 'track',
      name: 'Email Opened',
      timestamp: profile.lastSeen,
      properties: { subject: 'Signal #42: attribution is a story you tell' },
      context: { source: 'email' },
    },
    {
      eventId: demoId('evt', `${profileId}:page`),
      type: 'page',
      name: 'Page Viewed',
      timestamp: daysBefore(4, 10),
      properties: { path: '/archive/signal-42' },
      context: { source: 'web' },
    },
    {
      eventId: demoId('evt', `${profileId}:identify`),
      type: 'identify',
      name: 'Identity',
      timestamp: profile.firstSeen,
      properties: {},
      context: { source: 'import' },
    },
  ];
  return { events, nextCursor: null };
}

export function demoMessages(profileId?: string): Out<'messages.list'> {
  const rows: Message[] = [
    {
      id: demoId('msg', `${profileId ?? 'all'}:42`),
      channel: 'email',
      profileId: profileId ?? null,
      templateId: demoId('eml', 'email_template:Weekly Signal #42'),
      templateVersion: 1,
      purpose: 'marketing_email',
      status: 'delivered',
      reason: null,
      attempts: 1,
      nextAttemptAt: null,
      lastError: null,
      notBefore: null,
      segments: null,
      test: false,
      createdAt: daysBefore(7, 6),
      events: [
        { type: 'delivered', at: daysBefore(7, 6), reason: '', url: '' },
        { type: 'opened', at: daysBefore(6, 8), reason: '', url: '' },
        { type: 'clicked', at: daysBefore(6, 8), reason: '', url: 'https://martechsignal.example/latest' },
      ],
    },
    {
      id: demoId('msg', `${profileId ?? 'all'}:32`),
      channel: 'email',
      profileId: profileId ?? null,
      templateId: demoId('eml', 'email_template:Weekly Signal #42'),
      templateVersion: 1,
      purpose: 'marketing_email',
      status: 'sent',
      reason: null,
      attempts: 1,
      nextAttemptAt: null,
      lastError: null,
      notBefore: null,
      segments: null,
      test: false,
      createdAt: daysBefore(21, 6),
      events: [{ type: 'sent', at: daysBefore(21, 6), reason: '', url: '' }],
    },
  ];
  return { messages: rows, nextCursor: null };
}

export function demoConsentHistory(profileId: string): Out<'consent.history'> {
  const profile = DEMO_PROFILE_ROWS.find((row) => row.id === profileId);
  const consent = profile?.consent ?? [];
  const records: ConsentRecord[] = consent.map((entry) => ({
    purpose: entry.purpose,
    channel: entry.purpose.includes('email') ? 'email' : 'web',
    status: entry.status ?? 'granted',
    basis: purposeBasis.get(entry.purpose)?.basis ?? 'consent',
    source: 'import',
    proof: { import: 'Kit export 2026-10-20' },
    recordedAt: profile?.lastSeen ?? OWNER_AT,
    recordedBy: null,
  }));
  return { records };
}

export function demoConsentSummary(): Out<'consent.summary'> {
  const purposes = [...purposeBasis.keys()].map((key) => {
    const granted = DEMO_PROFILE_ROWS.filter((row) => row.consent.some((c) => c.purpose === key && c.status === 'granted')).length;
    const denied = DEMO_PROFILE_ROWS.filter((row) => row.consent.some((c) => c.purpose === key && c.status === 'denied')).length;
    return {
      purpose: key,
      granted,
      denied,
      withdrawn: 0,
      objected: 0,
      channels: [
        { channel: key.includes('sms') ? 'sms' : key.includes('email') ? 'email' : 'web', granted, denied, withdrawn: 0, objected: 0 },
      ],
    };
  });
  return {
    purposes,
    topics: [
      { purpose: 'marketing_email', topic: 'newsletter', subscribed: 18, unsubscribed: 6 },
      { purpose: 'marketing_email', topic: 'product_news', subscribed: 9, unsubscribed: 15 },
    ],
  };
}

export const DEMO_PURPOSES: Out<'purposes.list'> = {
  source: 'published',
  purposes: (DEMO_ARTIFACT_CONTENT.Purposes as { purposes: Purpose[] }).purposes,
};

export function demoTopics(profileId: string): Out<'topics.preferences'> {
  const index = Math.max(
    0,
    DEMO_PROFILE_ROWS.findIndex((row) => row.id === profileId),
  );
  return {
    topics: [
      {
        purpose: 'marketing_email',
        purposeName: 'Marketing e-mail',
        topic: 'newsletter',
        name: 'Weekly newsletter',
        description: 'The Friday issue',
        default: 'subscribed',
        status: 'subscribed',
        source: index % 3 === 0 ? 'preference_centre' : null,
        updatedAt: index % 3 === 0 ? daysBefore(5, 11) : null,
      },
      {
        purpose: 'marketing_email',
        purposeName: 'Marketing e-mail',
        topic: 'product_news',
        name: 'Product news',
        description: 'Launches and changes',
        default: 'unsubscribed',
        status: index % 2 === 0 ? 'unsubscribed' : 'subscribed',
        source: index % 2 === 0 ? null : 'preference_centre',
        updatedAt: index % 2 === 0 ? null : daysBefore(9, 11),
      },
    ],
  };
}

export function demoSegmentsOfProfile(profileId: string): Out<'segments.ofProfile'> {
  const index = Math.max(
    0,
    DEMO_PROFILE_ROWS.findIndex((row) => row.id === profileId),
  );
  return {
    segments: [
      { id: demoId('seg', 'segment:Newsletter subscribers'), name: 'Newsletter subscribers', since: daysBefore(30, 8) },
      ...(index % 2 === 0 ? [{ id: demoId('seg', 'segment:Engaged readers'), name: 'Engaged readers', since: daysBefore(12, 8) }] : []),
    ],
  };
}

// --- Home, agents, alerts, broadcasts -------------------------------------------------------

export const DEMO_STATUS: Out<'system.status'> = {
  serverVersion: '0.12.0',
  emailProvider: { configured: true, marketing: true, transactional: true, adapter: 'smtp', tracking: 'configurable' },
  pendingApprovals: DEMO_PENDING_APPROVALS.length,
};

export const DEMO_AGENTS: Out<'agents.list'> = {
  agents: [
    {
      id: '00000000-0000-4000-8000-00000000e1e2',
      name: 'Hermes',
      description: 'The editorial agent that drafts the weekly Signal and proposes changes.',
      sponsor: { id: DEMO_USER.id, name: DEMO_USER.name },
      status: 'active',
      statusReason: null,
      statusChangedAt: daysBefore(25, 9),
      brand: null,
      credentials: [{ kind: 'hosted', id: '00000000-0000-4000-8000-00000000e1e3', since: daysBefore(25, 9) }],
      guard: null,
      last24h: { changes: 4, denied: 0, escalated: 2, held: 0 },
      createdAt: daysBefore(40, 9),
    },
    {
      id: '00000000-0000-4000-8000-00000000e1e4',
      name: 'Scout',
      description: 'Watches deliverability and proposes pauses when the numbers turn.',
      sponsor: { id: DEMO_USER.id, name: DEMO_USER.name },
      status: 'paused',
      statusReason: 'Paused after two failed sends; a person clears the guard.',
      statusChangedAt: daysBefore(8, 9),
      brand: null,
      credentials: [{ kind: 'copilot', id: '00000000-0000-4000-8000-00000000e1e5', since: daysBefore(40, 9) }],
      guard: { cap: 2, reason: 'Two failed sends in a row', since: daysBefore(8, 9), episodeIds: [demoId('eps', 'scout:1')] },
      last24h: { changes: 1, denied: 1, escalated: 0, held: 0 },
      createdAt: daysBefore(40, 9),
    },
  ] as Agent[],
};

export const DEMO_ALERTS: Out<'alerts.list'> = {
  rules: [
    {
      id: demoId('alr', 'bounce'),
      name: 'Bounce rate over 5%',
      kind: 'deliverability',
      config: { metric: 'bounce', window: 'PT24H', threshold: 0.05, minSent: 100 },
      channels: [],
      enabled: true,
      createdBy: DEMO_USER.id,
      createdAt: daysBefore(30, 9),
      updatedAt: daysBefore(12, 9),
      state: 'ok',
      firingSince: null,
    },
    {
      id: demoId('alr', 'signup'),
      name: 'Signups dropped by half',
      kind: 'signup_drop',
      config: { window: 'PT24H', dropPercent: 50, minPrevious: 10 },
      channels: [],
      enabled: true,
      createdBy: DEMO_USER.id,
      createdAt: daysBefore(30, 9),
      updatedAt: daysBefore(12, 9),
      state: 'firing',
      firingSince: daysBefore(2, 7),
    },
  ] as AlertRule[],
};

export function demoAlertHistory(ruleId?: string): Out<'alerts.history'> {
  const rule = DEMO_ALERTS.rules.find((r) => r.id === ruleId) ?? DEMO_ALERTS.rules[1]!;
  return {
    events: [
      {
        id: demoId('alh', `${rule.id}:fired`),
        ruleId: rule.id,
        ruleName: rule.name,
        state: 'firing',
        value: 48,
        threshold: 50,
        window: 'PT24H',
        firedAt: daysBefore(2, 7),
        resolvedAt: null,
        notified: [],
      },
    ],
  };
}

const scheduledArtifact = artifactRow('Weekly Signal #44')!;

export const DEMO_BROADCASTS: Out<'broadcasts.list'> = {
  broadcasts: [
    {
      artifactId: scheduledArtifact.id,
      name: scheduledArtifact.name,
      latestVersion: scheduledArtifact.latestVersion,
      latestState: scheduledArtifact.latestState,
      publishedVersion: scheduledArtifact.publishedVersion,
      updatedAt: scheduledArtifact.updatedAt,
      run: {
        status: 'scheduled',
        version: 1,
        sendAt: daysBefore(-2, 6),
        recipients: 486,
        queued: 486,
        skipped: 0,
        windowSkipped: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
      },
      segmentId: demoId('seg', 'segment:Newsletter subscribers'),
      templateId: demoId('eml', 'email_template:Weekly Signal #44'),
      stage: null,
      delivery: {},
    } as unknown as Broadcast,
  ],
  total: 1,
  nextCursor: null,
  asOf: DEMO_NOW,
};

export const DEMO_RUN_FAILURES: Out<'agents.runFailures'> = { runs: [], nextCursor: null, asOf: DEMO_NOW };

export const DEMO_SENDING_DOMAINS: Out<'sendingDomains.list'> = {
  checkedAt: DEMO_NOW,
  domains: [
    {
      domain: 'martechsignal.example',
      ok: true,
      spf: { ok: true, record: 'v=spf1 include:mail.example ~all', advice: null },
      dkim: [{ selector: 'am', ok: true, record: 'am._domainkey CNAME am.domainkey.example' }],
      dmarc: { ok: true, record: 'v=DMARC1; p=none', advice: null, policy: 'none' },
      uses: ['marketing', 'transactional'],
    },
  ],
};

export const DEMO_MEMBER_ROWS: Out<'members.list'> = {
  members: DEMO_MEMBERS.map((member, index) => ({ ...member, since: daysBefore(60 - index, 9) })),
};

export const DEMO_PROPOSALS: Out<'workspace.proposals'> = {
  proposals: [
    {
      id: demoId('prp', 'time-zone'),
      changes: { timeZone: { from: 'UTC', to: 'Europe/Copenhagen' } },
      note: 'Use Copenhagen time for the newsletter schedule.',
      status: 'pending',
      requester: PERSON_REQUESTER,
      decidedBy: null,
      decisionNote: null,
      decidedAt: null,
      createdAt: daysBefore(3, 10),
      reviewUrl: null,
    },
  ],
};

export const DEMO_AUTONOMY: Out<'workspace.autonomy'> = {
  switch: 'propose_only',
  maxLevel: { draft: 3, 'content.publish': 2, 'send.broadcast': 2, 'send.direct': 1, 'journey.live': 1 },
  allowLoops: false,
  audienceThreshold: 500,
  limits: { changesPerDay: 20, messagesPerDay: 1000 },
  contactPressure: [{ max: 2, days: 7, channels: ['email'] }],
};

// --- Analytics ------------------------------------------------------------------------------

interface QueryInput {
  measures?: string[];
  dimensions?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

interface DayBase {
  sent: number;
  delivered: number;
  clicked: number;
  opened: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  conversions: number;
  revenue: number;
  orders: number;
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '2026-11-01' : date.toISOString().slice(0, 10);
}

function shift(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayBase(day: string): DayBase {
  let hash = 2166136261;
  for (const ch of day) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const sent = 280 + (hash % 120);
  const delivered = Math.round(sent * (0.955 + ((hash >>> 4) % 25) / 1000));
  const clicked = Math.round(delivered * (0.3 + ((hash >>> 8) % 90) / 1000));
  const opened = Math.round(delivered * (0.52 + ((hash >>> 12) % 80) / 1000));
  const bounced = sent - delivered;
  const complained = Math.max(0, Math.round(sent * 0.0004));
  const unsubscribed = Math.max(0, Math.round(delivered * 0.003));
  const conversions = Math.round(clicked * 0.16);
  return {
    sent,
    delivered,
    clicked,
    opened,
    bounced,
    complained,
    unsubscribed,
    conversions,
    revenue: conversions * 49,
    orders: conversions,
  };
}

function measureValue(measure: string, b: DayBase): number | null {
  switch (measure) {
    case 'email.sent':
      return b.sent;
    case 'email.delivered':
      return b.delivered;
    case 'email.opened':
      return b.opened;
    case 'email.clicked':
      return b.clicked;
    case 'email.bounced':
      return b.bounced;
    case 'email.complained':
      return b.complained;
    case 'email.unsubscribed':
      return b.unsubscribed;
    case 'email.click_rate':
      return b.delivered > 0 ? b.clicked / b.delivered : null;
    case 'email.open_rate':
      return b.delivered > 0 ? b.opened / b.delivered : null;
    case 'email.bounce_rate':
      return b.sent > 0 ? b.bounced / b.sent : null;
    case 'email.complaint_rate':
      return b.sent > 0 ? b.complained / b.sent : null;
    case 'email.unsubscribe_rate':
      return b.delivered > 0 ? b.unsubscribed / b.delivered : null;
    case 'email.delivery_rate':
      return b.sent > 0 ? b.delivered / b.sent : null;
    case 'conversions':
      return b.conversions;
    case 'revenue':
      return b.revenue;
    case 'orders':
      return b.orders;
    default:
      return null;
  }
}

function sumBases(bases: DayBase[]): DayBase {
  return bases.reduce<DayBase>(
    (acc, base) => ({
      sent: acc.sent + base.sent,
      delivered: acc.delivered + base.delivered,
      clicked: acc.clicked + base.clicked,
      opened: acc.opened + base.opened,
      bounced: acc.bounced + base.bounced,
      complained: acc.complained + base.complained,
      unsubscribed: acc.unsubscribed + base.unsubscribed,
      conversions: acc.conversions + base.conversions,
      revenue: acc.revenue + base.revenue,
      orders: acc.orders + base.orders,
    }),
    { sent: 0, delivered: 0, clicked: 0, opened: 0, bounced: 0, complained: 0, unsubscribed: 0, conversions: 0, revenue: 0, orders: 0 },
  );
}

/**
 * A deterministic analytics answer for any requested period. Counts are base measures summed over
 * local days; ratios are computed once from those sums, exactly as the server does, so Home and the
 * Analytics page reconcile instead of summing daily unique counts.
 */
export function demoAnalyticsQuery(input: QueryInput): Out<'analytics.query'> {
  const measures = input.measures ?? [];
  const from = input.from ?? daysBefore(7);
  const to = input.to ?? DEMO_NOW;
  const fromDay = dayKey(from);
  const toDay = dayKey(to);
  const days: string[] = [];
  for (let day = fromDay; day <= toDay && days.length < 400; day = shift(day, 1)) days.push(day);
  const bases = days.map(dayBase);
  const totals = sumBases(bases);
  const columns: Out<'analytics.query'>['columns'] = [];
  const series = (input.dimensions ?? []).includes('day');
  if (series) columns.push({ name: 'day', kind: 'dimension' });
  for (const measure of measures) {
    columns.push({ name: measure, kind: 'measure', unit: measureUnit(measure) ?? 'count' });
  }
  const rows: (string | number | null)[][] = series
    ? days.map((day, index) => [day, ...measures.map((measure) => measureValue(measure, bases[index]!))])
    : [measures.map((measure) => measureValue(measure, totals))];
  return {
    columns,
    rows,
    meta: {
      timeZone: DEMO_TIME_ZONE,
      currency: 'DKK',
      from,
      to,
      freshness: DEMO_NOW,
      suppressed: 0,
      k: 5,
      notes: [],
    },
  };
}

export const DEMO_METRICS: Out<'analytics.metrics.list'> = {
  measures: Object.entries(ANALYTICS_MEASURES).map(([id, measure]) => ({
    id,
    description: measure.description,
    unit: measure.unit,
    aggregation: measure.unit === 'ratio' ? 'computed' : 'sum',
    source: id.startsWith('journey.') ? 'journey_events' : id.startsWith('segment.') ? 'segment_memberships' : 'message_events',
    dimensions: ['day'],
    defaultGrain: 'day',
    kind: measure.unit === 'ratio' ? 'ratio' : 'base',
    ...(measure.denominator ? { denominator: measure.denominator } : {}),
  })),
  dimensions: [{ id: 'day', description: 'Local calendar day', time: true, sources: ['message_events', 'journey_events', 'events'] }],
};

export function demoJourneyStats(_journeyId: string): Out<'journeys.stats'> {
  return {
    now: { ready: 34, waiting: 46, completed: 45, exited: 20, failed: 2, converted: 12 },
    waitingAt: { n3: 34, n4: 12 },
    reached: { n1: 120, n2: 120, n3: 86, n4: 52, n5: 45, n6: 7, n7: 45, n8: 20 },
    duplicatesSkipped: 2,
    missingKeySkipped: 0,
  };
}

export const DEMO_AI_USAGE: Out<'ai.usage'> = {
  days: [
    {
      day: dayKey(DEMO_NOW),
      kind: 'generate',
      model: 'hermes-editorial',
      calls: 12,
      fallbacks: 0,
      inputTokens: 18400,
      outputTokens: 6200,
      cost: 0.42,
    },
    {
      day: dayKey(daysBefore(1)),
      kind: 'decide',
      model: 'hermes-editorial',
      calls: 8,
      fallbacks: 1,
      inputTokens: 9600,
      outputTokens: 2100,
      cost: 0.19,
    },
  ],
};

export const DEMO_AI_CALLS: Out<'ai.calls'> = { calls: [] };
export const DEMO_AI_REVIEWS: Out<'ai.reviews'> = { reviews: [], quality: [] };

// --- Templates, blocks, assets and recipes -------------------------------------------------

export function demoTemplatePreview(): Out<'templates.preview'> {
  return {
    version: 1,
    subject: 'Weekly Signal #42',
    preheader: 'Plus three tools worth a look',
    html: '<html><body><h1>Signal #42</h1><p>This week: why last-click attribution keeps winning arguments it should lose.</p></body></html>',
    text: 'Signal #42\n\nThis week: why last-click attribution keeps winning arguments it should lose.',
    warnings: [],
  };
}

export function demoTemplateCheck(): Out<'templates.check'> {
  return {
    version: 1,
    findings: [],
    checkedAt: DEMO_NOW,
    summary: { blocking: 0, warning: 0, info: 0 },
  };
}

export const DEMO_BLOCK_USAGE: Out<'blocks.usage'> = { templates: [] };

export const DEMO_ASSETS: Out<'assets.list'> = { assets: [], nextCursor: null };

export const DEMO_RECIPES: Out<'recipes.list'> = {
  recipes: [
    {
      id: 'weekly-newsletter',
      version: 1,
      title: 'Weekly newsletter',
      description: 'A newsletter form, welcome journey, segment and first issue.',
      artifacts: 4,
      parameters: [{ key: 'publicationName', label: 'Publication name', type: 'string', required: true, default: 'MartechSignal' }],
      prerequisites: 0,
    },
  ],
};

export const DEMO_RECIPE: Out<'recipes.get'> = {
  recipe: {
    format: 'agentic-marketing/recipe@1',
    id: 'weekly-newsletter',
    version: 1,
    title: 'Weekly newsletter',
    description: 'A newsletter form, welcome journey, segment and first issue.',
    parameters: [
      {
        key: 'publicationName',
        label: 'Publication name',
        description: 'Shown in the sample content.',
        type: 'string',
        required: true,
        default: 'MartechSignal',
      },
    ],
    prerequisites: [],
    artifacts: [],
    docs: 'The recipe creates a form, a segment, a welcome journey and a first draft issue.',
    checklist: ['Review the consent text', 'Publish the form'],
  },
};

export function demoRecipePreview(): Out<'recipes.preview'> {
  return {
    recipe: { id: 'weekly-newsletter', version: 1, title: 'Weekly newsletter' },
    params: { publicationName: 'MartechSignal' },
    prerequisites: [],
    ready: true,
    artifacts: [],
    checklist: ['Review the consent text', 'Publish the form'],
    docs: 'The recipe creates a form, a segment, a welcome journey and a first draft issue.',
  };
}

// --- Settings reads -------------------------------------------------------------------------

export const DEMO_TOKENS: Out<'apiTokens.list'> = { tokens: [] };
export const DEMO_SECRETS: Out<'secrets.list'> = { secrets: [] };
export const DEMO_INVITATIONS: Out<'invitations.list'> = { invitations: [] };
export const DEMO_WEBHOOKS: Out<'webhooks.list'> = {
  endpoints: [
    {
      id: demoId('whk', 'hermes'),
      name: 'Hermes',
      url: 'https://hermes.example/hooks/agentic-marketing',
      events: ['approval.requested', 'artifact.published'],
      purpose: null,
      enabled: true,
      createdAt: daysBefore(30, 9),
    },
  ],
};
export const DEMO_CONNECTIONS: Out<'connections.list'> = { connections: [] };
export const DEMO_CONNECTORS: Out<'connectors.list'> = { connectors: [] };
export const DEMO_SOURCES: Out<'sources.list'> = { sources: [] };
export const DEMO_EMAIL_PROVIDERS: Out<'emailProviders.list'> = { providers: [], adapters: [], warnings: [] };
export const DEMO_SMS_PROVIDERS: Out<'smsProviders.list'> = { providers: [] };
export const DEMO_PUSH_PROVIDERS: Out<'pushProviders.list'> = { providers: [] };
export const DEMO_AI_PROVIDERS: Out<'aiProviders.list'> = { providers: [] };
export const DEMO_SSO: Out<'sso.list'> = { providers: [] };
export const DEMO_SCIM: Out<'scim.status'> = {
  configured: false,
  enabled: false,
  defaultRole: 'viewer',
  groupRoles: {},
  hasToken: false,
  users: 0,
  groups: 0,
};

/** Settings pages read the shared workspace, member and provider lists; they render from these. */
export const DEMO_WORKSPACE_ID_VALUE = DEMO_WORKSPACE_ID;
export const DEMO_WORKSPACE_VALUE = DEMO_WORKSPACE;

/** Content topics (Consent → Topics) — empty is a real, honest state for the sample. */
export const DEMO_TOPICS: Out<'content.topics.list'> = { topics: [], count: 0 };

export const DEMO_AUDIT: Out<'audit.list'> = { entries: [] };
export const DEMO_CAMPAIGNS_OF: Out<'campaigns.of'> = { campaigns: [] };
