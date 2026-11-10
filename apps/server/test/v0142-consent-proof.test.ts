import { createClient } from '@agentic-marketing/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// #594: consent proof carries the SDK context's `ip`, `userAgent` and `page`, and free-form
// evidence such as call notes can hold contact data too. The ledger is readable with
// `profiles:read`, so without `profiles:pii` the server withholds those fields and says so; the
// UI must never receive or print them.

const PORT = testPort(4310);
const IP = '203.0.113.7';
const USER_AGENT = 'Mozilla/5.0 (privacy test)';
const PAGE = 'https://example.com/preferences?email=ada@example.com';
const NOTE = 'called ada@example.com on +45 12 34 56 78';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let admin: User;
let marketer: User;
let approver: User;
let ws = '';
let profileId = '';

beforeAll(async () => {
  t = await startTestServer('test_v0142_consent_proof', PORT);
  owner = await t.signUp(`owner-594-${Date.now()}@example.com`);
  admin = await t.signUp(`admin-594-${Date.now()}@example.com`);
  marketer = await t.signUp(`marketer-594-${Date.now()}@example.com`);
  approver = await t.signUp(`approver-594-${Date.now()}@example.com`);
  ws = await t.workspaceWith([
    [owner, 'owner'],
    [admin, 'admin'],
    [marketer, 'marketer'],
    [approver, 'approver'],
  ]);
  const api = t.api(owner, ws);
  await api.call('profiles.import', {
    label: 'privacy ledger test',
    rows: [
      {
        email: 'ada@example.com',
        consent: [{ purpose: 'marketing_email', status: 'granted', proof: { system: 'Kit', import: 'privacy ledger test' } }],
      },
    ],
  });
  // The import lands on the bus, so the profile appears asynchronously.
  const found = await eventually(
    () => api.call('profiles.find', { type: 'email', value: 'ada@example.com' }),
    (r) => !!r.profileId,
  );
  profileId = found.profileId!;
  expect(profileId).toBeTruthy();
  // The shape the SDK writes (resolve.ts recordSdkConsent), plus a free-text call note.
  await api.call('consent.record', {
    profileId,
    purpose: 'marketing_email',
    status: 'granted',
    channel: 'email',
    source: 'form',
    proof: {
      messageId: 'msg_594',
      sourceId: 'frm_594',
      form_id: 'form_594',
      form_version: 2,
      double_opt_in: true,
      ip: IP,
      userAgent: USER_AGENT,
      page: PAGE,
      note: NOTE,
    },
  });
}, 60_000);

afterAll(() => t?.close());

const recordOf = (records: { proof: Record<string, unknown>; proofWithheld: boolean }[]) =>
  records.find((r) => r.proof.messageId === 'msg_594')!;

describe('consent.history proof without profiles:pii (#594)', () => {
  for (const [role, user] of [
    ['marketer', () => marketer],
    ['approver', () => approver],
  ] as const) {
    it(`withholds personal proof fields from a ${role}`, async () => {
      const history = await t.api(user(), ws).call('consent.history', { profileId });
      const record = recordOf(history.records);
      expect(record.proofWithheld).toBe(true);
      expect(record.proof).not.toHaveProperty('ip');
      expect(record.proof).not.toHaveProperty('userAgent');
      expect(record.proof).not.toHaveProperty('page');
      expect(record.proof).not.toHaveProperty('note');
      // The non-personal evidence stays: what was agreed to, on which form, from where.
      expect(record.proof).toMatchObject({
        messageId: 'msg_594',
        sourceId: 'frm_594',
        form_id: 'form_594',
        double_opt_in: true,
      });
      const json = JSON.stringify(history);
      expect(json).not.toContain(IP);
      expect(json).not.toContain(USER_AGENT);
      expect(json).not.toContain(PAGE);
      expect(json).not.toContain(NOTE);
    });
  }

  for (const [role, user] of [
    ['owner', () => owner],
    ['admin', () => admin],
  ] as const) {
    it(`returns the full proof to ${role}, who has profiles:pii`, async () => {
      const history = await t.api(user(), ws).call('consent.history', { profileId });
      const record = recordOf(history.records);
      expect(record.proofWithheld).toBe(false);
      expect(record.proof).toMatchObject({ ip: IP, userAgent: USER_AGENT, page: PAGE, note: NOTE, messageId: 'msg_594' });
    });
  }

  it('marks the import proof as not withheld for a marketer (it is all non-personal)', async () => {
    const history = await t.api(marketer, ws).call('consent.history', { profileId });
    const imported = history.records.find((r) => r.proof.system === 'Kit')!;
    expect(imported.proofWithheld).toBe(false);
    expect(imported.proof).toMatchObject({ system: 'Kit', import: 'privacy ledger test' });
  });

  it('is the same over an API token with only profiles:read', async () => {
    const token = await t.api(owner, ws).call('apiTokens.create', { name: 'ledger reader', scopes: ['profiles:read'] });
    const client = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });
    const history = await client.call('consent.history', { profileId });
    const record = recordOf(history.records);
    expect(record.proofWithheld).toBe(true);
    expect(JSON.stringify(history)).not.toContain(IP);
  });
});

describe('profiles.export proof (#594)', () => {
  it('keeps the full proof for the human who may export personal data', async () => {
    const exported = await t.api(owner, ws).call('profiles.export', { profileId });
    const record = exported.consentRecords.find((r) => (r.proof as Record<string, unknown>).messageId === 'msg_594')!;
    expect(record.proof).toMatchObject({ ip: IP, userAgent: USER_AGENT, page: PAGE });
  });

  it('refuses a marketer the export instead of returning a withheld proof', async () => {
    const err = await rejects(t.api(marketer, ws).call('profiles.export', { profileId }));
    expect(err.code).toBe('forbidden');
  });
});
