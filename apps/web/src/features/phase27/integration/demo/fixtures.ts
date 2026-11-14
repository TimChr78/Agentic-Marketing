import type { Out } from '../../../../app/api';

// A bounded, plain-data projection of `apps/server/test/e2e/seed.ts` (#524). It is deliberately a
// copy, not an import: the seed uses Postgres, ClickHouse, NATS, `node:crypto` and the server
// registry, none of which may enter the browser bundle. Keep these values in step with the seed:
// the fixed clock, UTC workspace time zone, MartechSignal brand, four members and their roles, and
// the artifact names the demo destinations show. Task D maps commands onto this projection and
// adds the remaining fixtures; nothing here is a live read or evidence.

export type DemoArtifactRow = Out<'artifacts.list'>['artifacts'][number];
export type DemoWorkspace = Out<'workspace.get'>;
export type DemoMembership = Out<'workspace.memberships'>['workspaces'][number];
export type DemoApproval = Out<'approvals.list'>['approvals'][number];

/** `FIXED_NOW` in the e2e seed: every fixture timestamp is at or before this instant. */
export const DEMO_NOW = '2026-11-02T09:00:00.000Z';
/** The seeded workspace time zone (`workspaces.time_zone`), before the pending Copenhagen proposal. */
export const DEMO_TIME_ZONE = 'UTC';
export const DEMO_SERVER_VERSION = '0.12.0';

/** A deterministic 32-hex body, so fixture ids are stable across reloads without a hash import. */
function body(label: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const ch of label) {
    a = Math.imul(a ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    b = Math.imul(b + ch.charCodeAt(0), 0x85ebca6b) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 4; i++) {
    a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0;
    b = Math.imul(b ^ (b >>> 15), 0x27d4eb2f) >>> 0;
    out += (a ^ b).toString(16).padStart(8, '0');
  }
  return out;
}

export function demoId(prefix: string, label: string): string {
  return `${prefix}_${body(label)}`;
}

export const DEMO_WORKSPACE_ID = '00000000-0000-4000-8000-000000000524';
export const DEMO_SANDBOX_ID = '00000000-0000-4000-8000-000000000525';

export const DEMO_USER = { id: '00000000-0000-4000-8000-00000000a1e2', name: 'Alex Morgan', email: 'alex@example.com' };

/** `ROLE_PERMISSIONS.owner` from packages/commands/src/principal.ts, kept as data for the demo. */
export const DEMO_PERMISSIONS = [
  'artifacts:read',
  'artifacts:write',
  'artifacts:publish',
  'artifacts:approve',
  'messages:send',
  'audit:read',
  'profiles:read',
  'profiles:pii',
  'profiles:write',
  'profiles:erase',
  'secrets:read',
  'secrets:write',
  'workspace:admin',
] as const;

/** The workspace `workspace.get` returns for the demo owner: approval policy `agent_changes`. */
export const DEMO_WORKSPACE: DemoWorkspace = {
  id: DEMO_WORKSPACE_ID,
  name: 'MartechSignal',
  approvalPolicy: 'agent_changes',
  timeZone: DEMO_TIME_ZONE,
  seedList: ['inbox-check@example.com'],
  domains: [],
  linksUrl: 'https://links.example',
  brand: { siteName: 'MartechSignal', logoUrl: null, primaryDomain: null },
  serverVersion: DEMO_SERVER_VERSION,
  you: { type: 'user', userId: DEMO_USER.id, role: 'owner', permissions: [...DEMO_PERMISSIONS] },
  permissionsExplained: [...DEMO_PERMISSIONS].map((permission) => ({
    permission,
    meaning: 'Available in the demo as it is in the real workspace.',
  })),
};

export const DEMO_MEMBERSHIPS: DemoMembership[] = [
  { id: DEMO_WORKSPACE_ID, name: 'MartechSignal', role: 'owner', brand: DEMO_WORKSPACE.brand },
  { id: DEMO_SANDBOX_ID, name: 'Sandbox', role: 'admin', brand: { siteName: 'Sandbox', logoUrl: null, primaryDomain: null } },
];

/** The four seeded members and their roles (`PEOPLE` in the seed). */
export const DEMO_MEMBERS = [
  { userId: DEMO_USER.id, name: 'Alex Morgan', email: 'alex@example.com', role: 'owner' as const },
  { userId: '00000000-0000-4000-8000-00000000b1e2', name: 'Sam Rivera', email: 'sam@example.com', role: 'marketer' as const },
  { userId: '00000000-0000-4000-8000-00000000c1e2', name: 'Jo Lee', email: 'jo@example.com', role: 'approver' as const },
  { userId: '00000000-0000-4000-8000-00000000d1e2', name: 'Vic Chen', email: 'vic@example.com', role: 'viewer' as const },
];

const at = (day: number, hour = 9) =>
  new Date(Date.UTC(2026, 9, day, hour, 0, 0)).toISOString() <= DEMO_NOW
    ? new Date(Date.UTC(2026, 9, day, hour, 0, 0)).toISOString()
    : DEMO_NOW;

function artifact(
  type: string,
  prefix: string,
  name: string,
  state: DemoArtifactRow['latestState'],
  latestVersion: number,
  publishedVersion: number | null,
  updatedAt: string,
): DemoArtifactRow {
  return {
    id: demoId(prefix, `${type}:${name}`),
    type,
    name,
    latestVersion,
    latestState: state,
    publishedVersion,
    updatedAt,
    archived: false,
  };
}

/**
 * A bounded slice of the seeded artifacts: enough for the demo destinations' lists and pickers.
 * Names, publication states and versions follow the seed; timestamps stop at `DEMO_NOW`.
 */
export const DEMO_ARTIFACTS: DemoArtifactRow[] = [
  artifact('brand', 'brd', 'Brand', 'published', 1, 1, at(20)),
  artifact('purposes', 'pur', 'Purposes', 'published', 1, 1, at(20)),
  artifact('email_template', 'eml', 'Confirm your subscription', 'published', 1, 1, at(21)),
  artifact('email_template', 'eml', 'Weekly Signal #42', 'published', 1, 1, at(22)),
  artifact('email_template', 'eml', 'Weekly Signal #43', 'draft', 1, null, at(28, 14)),
  artifact('email_template', 'eml', 'Weekly Signal #44', 'draft', 1, null, at(29, 14)),
  artifact('email_template', 'eml', 'Reader onboarding: welcome', 'published', 1, 1, at(27)),
  artifact('segment', 'seg', 'Newsletter subscribers', 'published', 1, 1, at(23)),
  artifact('segment', 'seg', 'Engaged readers', 'published', 1, 1, at(23)),
  artifact('segment', 'seg', 'VIP readers', 'published', 1, 1, at(30)),
  artifact('form', 'frm', 'Newsletter signup', 'published', 1, 1, at(24)),
  artifact('form', 'frm', 'Footer signup', 'published', 1, 1, at(24)),
  artifact('broadcast', 'bct', 'Signal #41: the archive issue', 'published', 1, 1, at(30)),
  artifact('broadcast', 'bct', 'Signal #42 resend to engaged readers', 'draft', 1, null, at(28, 16)),
  artifact('broadcast', 'bct', 'Signal #32: the vendor shortlist', 'published', 1, 1, at(9)),
  artifact('journey', 'jrn', 'Welcome series', 'published', 1, 1, at(25)),
  artifact('journey', 'jrn', 'Reader onboarding', 'published', 1, 1, at(28)),
  artifact('experience', 'exp', 'Newsletter banner on articles', 'published', 1, 1, at(26)),
  artifact('experience', 'exp', 'Newsletter banner: autumn test', 'draft', 1, null, at(31)),
  artifact('campaign', 'cmp', 'Signal autumn 2026', 'published', 1, 1, at(26)),
  artifact('agent_mandate', 'mnd', 'Hermes newsletter mandate', 'published', 1, 1, at(27)),
  artifact('prompt', 'prm', 'Signal analyst', 'published', 1, 1, at(27)),
];

const requester = {
  kind: 'person' as const,
  displayName: 'Sam Rivera',
  personName: 'Sam Rivera',
  tokenName: null,
  tokenId: null,
  clientName: null,
};
const agentAuthor = { type: 'agent' as const, id: '00000000-0000-4000-8000-00000000e1e2', client: 'Hermes' };

function approval(artifactId: string, name: string, type: string, note: string, createdAt: string): DemoApproval {
  return {
    id: demoId('apr', `${artifactId}:${createdAt}`),
    artifactId,
    artifactName: name,
    artifactType: type,
    version: 1,
    status: 'pending',
    requestedBy: agentAuthor,
    requester,
    note,
    decidedBy: null,
    decisionNote: null,
    createdAt,
    holdUntil: null,
    artifactLatestVersion: 1,
    artifactPublishedVersion: null,
    reviewUrl: null,
    bundle: null,
  };
}

const byName = (name: string) => DEMO_ARTIFACTS.find((a) => a.name === name)!;

/** The seeded pending reviews: the agent's issue #43, the resend, and the weekly pair. */
export const DEMO_PENDING_APPROVALS: DemoApproval[] = [
  approval(
    byName('Weekly Signal #43').id,
    'Weekly Signal #43',
    'email_template',
    'Draft of issue 43 from the editorial outline.',
    at(28, 14),
  ),
  approval(
    byName('Signal #42 resend to engaged readers').id,
    'Signal #42 resend to engaged readers',
    'broadcast',
    'Resend #42 on Friday morning, Copenhagen time.',
    at(28, 16),
  ),
  approval(byName('Weekly Signal #44').id, 'Weekly Signal #44', 'email_template', 'Next issue, ready for review.', at(29, 14)),
];

/** The seeded people the demo screens can show without pretending to have all 520. */
export const DEMO_PEOPLE = Array.from({ length: 24 }, (_, i) => ({
  userId: `reader-${i + 1}`,
  email: `reader${i + 1}@example.net`,
  firstName: ['Ada', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara'][i % 6],
  lastName: ['Andersen', 'Nielsen', 'Petersen', 'Larsen', 'Sørensen', 'Rasmussen'][i % 6],
  city: i % 2 ? 'Copenhagen' : 'Aarhus',
  consent: i % 7 === 6 ? ('withdrawn' as const) : ('granted' as const),
  createdAt: '2026-09-01T08:00:00.000Z',
}));
