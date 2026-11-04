import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  adAudienceCommands,
  metaEmail,
  metaPhone,
  runAudienceSyncRound,
  selectAudienceSyncRound,
  syncAudience,
} from '@agentic-marketing/ads';
import type { AudienceSync } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// 0.7.4 audience reconciliation (#400, #401, #402). The fake platforms model membership, not
// request counts: a remove deletes the whole user/member, exactly like Meta and Google. That is
// what catches an identifier-type shrink that removes the person but records the other identifier
// as still present. Nothing here reaches a real ad account.

type FakeMember = { email?: string; phone?: string };
const remote = new Map<string, FakeMember[]>();
let platformUrl = '';
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
const ids = { meta: '', meta2: '', google: '', google2: '' };

type Received = { method: string; path: string; body: string; account: string | null };
const received: Received[] = [];

// Injected provider failures after the remote change was applied (a timeout/connection drop) and
// a DB failure hook used by the ledger-failure test.
let failAddAfterApply: 'destroy' | 'http500' | null = null;
let failRemoveAfterApply: 'destroy' | 'http500' | null = null;
let afterApply: (() => void) | null = null;
// A concurrent-run test holds one add response until a second run has tried the lock.
let holdAdds = false;
let addReached: (() => void) | null = null;
let releaseAdd: (() => void) | null = null;

const keyOf = (platform: 'meta' | 'google', destination: string, account = '') =>
  platform === 'meta' ? `meta:${destination}` : `google:${account}:${destination}`;

function upsertMember(key: string, member: FakeMember) {
  const list = remote.get(key) ?? [];
  const found = list.find((m) => (member.email && m.email === member.email) || (member.phone && m.phone === member.phone));
  if (found) Object.assign(found, member);
  else list.push({ ...member });
  remote.set(key, list);
}

function removeMember(key: string, member: FakeMember) {
  const list = remote.get(key) ?? [];
  remote.set(
    key,
    list.filter((m) => !((member.email && m.email === member.email) || (member.phone && m.phone === member.phone))),
  );
}

const membersOf = (platform: 'meta' | 'google', destination: string, account = '') =>
  remote.get(keyOf(platform, destination, account)) ?? [];

function metaMembers(body: string): FakeMember[] {
  const parsed = JSON.parse(body) as { payload: { schema: string[]; data: string[][] } };
  return parsed.payload.data.map((row) => {
    const member: FakeMember = {};
    parsed.payload.schema.forEach((column, i) => {
      if (column === 'EMAIL') member.email = row[i];
      if (column === 'PHONE') member.phone = row[i];
    });
    return member;
  });
}

function googleMembers(body: string): FakeMember[] {
  const parsed = JSON.parse(body) as {
    audienceMembers: { userData: { userIdentifiers: { emailAddress?: string; phoneNumber?: string }[] } }[];
  };
  return parsed.audienceMembers.map((m) => {
    const member: FakeMember = {};
    for (const id of m.userData.userIdentifiers) {
      if (id.emailAddress) member.email = id.emailAddress;
      if (id.phoneNumber) member.phone = id.phoneNumber;
    }
    return member;
  });
}

const platforms = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/token') return json(200, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    const path = req.url ?? '';
    const meta = /^\/v24\.0\/(\d+)\/users$/.exec(path);
    const google = path.endsWith(':ingest') || path.endsWith(':remove');
    let account: string | null = null;
    let destination: string | null = null;
    if (meta) destination = meta[1]!;
    if (google) {
      const parsed = JSON.parse(raw) as {
        destinations: { operatingAccount: { accountId: string }; productDestinationId: string }[];
      };
      account = parsed.destinations[0]!.operatingAccount.accountId;
      destination = parsed.destinations[0]!.productDestinationId;
    }
    received.push({ method: req.method ?? '', path, body: raw, account });
    if (destination) {
      const op = req.method === 'DELETE' || path.endsWith(':remove') ? 'remove' : 'add';
      const members = meta ? metaMembers(raw) : googleMembers(raw);
      for (const member of members) {
        const remoteKey = meta ? keyOf('meta', destination) : keyOf('google', destination, account!);
        if (op === 'add') upsertMember(remoteKey, member);
        else removeMember(remoteKey, member);
      }
      if (op === 'add' && holdAdds) {
        await new Promise<void>((resolve) => {
          releaseAdd = resolve;
          addReached?.();
        });
      }
      const fail = op === 'add' ? failAddAfterApply : failRemoveAfterApply;
      if (fail === 'destroy') {
        if (op === 'add') failAddAfterApply = null;
        else failRemoveAfterApply = null;
        req.socket.destroy();
        return;
      }
      if (fail === 'http500') {
        if (op === 'add') failAddAfterApply = null;
        else failRemoveAfterApply = null;
        return json(500, { error: { message: 'injected provider failure after apply' } });
      }
      if (afterApply) {
        const cb = afterApply;
        afterApply = null;
        cb();
      }
    }
    json(200, { ok: true });
  });
});

const api = () => t.api(owner);
const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

async function person(userId: string, email: string, phone: string, plan: string) {
  await send([{ type: 'identify', userId, traits: { email, phone, plan } }]);
  const { profileId } = await eventually(
    () => api().call('profiles.find', { type: 'user_id', value: userId }),
    (r) => !!r.profileId,
  );
  await api().call('consent.record', {
    profileId: profileId!,
    purpose: 'ad_targeting',
    status: 'granted',
    source: 'api',
    proof: { test: true },
  });
  return profileId!;
}

async function createSegment(name: string, staticList = false) {
  const a = await api().call('artifacts.create', {
    type: 'segment',
    name: `Audience ${name}`,
    content: staticList ? { mode: 'static' } : { condition: { trait: 'plan', op: 'eq', value: name } },
  });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId;
}

async function addToSegment(segment: string, profileId: string) {
  await t.srv.db.admin.query(
    `INSERT INTO segment_memberships (workspace_id, segment_id, profile_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [ws, segment, profileId],
  );
}

async function createSync(content: Record<string, unknown>) {
  const a = await api().call('artifacts.create', { type: 'audience_sync', name: 'Audience sync', content });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId;
}

async function updateSync(artifactId: string, content: Record<string, unknown>) {
  await api().call('artifacts.updateDraft', { artifactId, content });
  await api().call('artifacts.requestPublish', { artifactId, note: 'change' });
}

const syncNow = async (artifactId: string) => (await api().call('ads.syncAudience', { artifactId })).results;

const connect = async (id: string) => {
  const { url } = await api().call('connections.authorize', { id });
  expect((await fetch(`${t.base}/oauth/callback?code=c&state=${new URL(url).searchParams.get('state')}`)).status).toBe(200);
};

function defOf(segment: string, extra: Record<string, unknown> = {}): AudienceSync {
  return {
    segment,
    identifiers: ['email', 'phone'],
    removals: true,
    meta: { connection: ids.meta, audienceId: '90000001' },
    ...extra,
  } as unknown as AudienceSync;
}

function ledgerFailureDb() {
  let failNext = false;
  const db = {
    admin: t.srv.db.admin,
    app: t.srv.db.app,
    withWorkspace: async <T>(
      workspace: string,
      fn: (tx: Parameters<typeof t.srv.db.withWorkspace>[1] extends (tx: infer X) => unknown ? X : never) => Promise<T>,
      opts?: { snapshot?: boolean },
    ) => {
      if (failNext) {
        failNext = false;
        throw new Error('injected audience ledger failure');
      }
      return t.srv.db.withWorkspace(workspace, fn as never, opts);
    },
    ping: () => t.srv.db.ping(),
    close: () => t.srv.db.close(),
  } as typeof t.srv.db;
  return { db, failNext: () => (failNext = true) };
}

beforeAll(async () => {
  await new Promise<void>((r) => platforms.listen(0, '127.0.0.1', r));
  platformUrl = `http://127.0.0.1:${(platforms.address() as AddressInfo).port}`;
  t = await startTestServer('test_v074_audience_reconciliation', testPort(3596));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  ids.meta = (
    await api().call('connections.create', {
      connector: 'meta_ads',
      name: 'Meta one',
      settings: { pixelId: '123456789', adAccountId: 'act_1234567', apiBase: platformUrl },
      secrets: { accessToken: 'meta-system-user-token-0123456789' },
    })
  ).id;
  ids.meta2 = (
    await api().call('connections.create', {
      connector: 'meta_ads',
      name: 'Meta two',
      settings: { pixelId: '987654321', adAccountId: 'act_7654321', apiBase: platformUrl },
      secrets: { accessToken: 'meta-system-user-token-9876543210' },
    })
  ).id;
  ids.google = (
    await api().call('connections.create', {
      connector: 'google_ads',
      name: 'Google Ads',
      settings: {
        customerId: '1111111111',
        apiBase: platformUrl,
        reportingBase: platformUrl,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'gc', clientSecret: 'gs', developerToken: 'dev-token-123' },
    })
  ).id;
  ids.google2 = (
    await api().call('connections.create', {
      connector: 'google_ads',
      name: 'Google Ads two',
      settings: {
        customerId: '2222222222',
        apiBase: platformUrl,
        reportingBase: platformUrl,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'gc2', clientSecret: 'gs2', developerToken: 'dev-token-456' },
    })
  ).id;
  await connect(ids.google);
  await connect(ids.google2);
}, 60_000);

afterAll(async () => {
  await t?.close();
  platforms.closeAllConnections();
  platforms.close();
});

beforeEach(() => {
  received.length = 0;
  failAddAfterApply = null;
  failRemoveAfterApply = null;
  afterApply = null;
  holdAdds = false;
  addReached = null;
  releaseAdd = null;
});

describe('destination provenance and member-level reconciliation', () => {
  it('restores the full current identifier set after an identifier type is removed (#401 P1)', async () => {
    const segment = await createSegment('shrink');
    const profile = await person('shrink-a', 'shrink-a@example.com', '+4511000001', 'shrink');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000101' } });
    expect((await syncNow(sync))[0]).toMatchObject({ platform: 'meta', added: 1, members: 1 });
    expect(membersOf('meta', '90000101')).toEqual([{ email: metaEmail('shrink-a@example.com'), phone: metaPhone('+4511000001') }]);

    // Meta/Google remove a user/member, not one identifier key: after removing the e-mail the
    // phone must be uploaded again, or the person is silently gone while the ledger says present.
    await updateSync(sync, { segment, identifiers: ['phone'], meta: { connection: ids.meta, audienceId: '90000101' } });
    const [phoneOnly] = await syncNow(sync);
    expect(phoneOnly).toMatchObject({ status: 'ok', members: 1 });
    expect(membersOf('meta', '90000101')).toEqual([{ phone: metaPhone('+4511000001') }]);
    const stored = await t.srv.db.admin.query<{ hashes: { email?: string; phone?: string } }>(
      `SELECT hashes FROM audience_members WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = $3`,
      [ws, sync, profile],
    );
    expect(stored.rows[0]!.hashes).toEqual({ phone: metaPhone('+4511000001') });
  });

  it('uses the stored Google operating account when the connection settings changed (#400 P2)', async () => {
    const segment = await createSegment('account');
    const profile = await person('account-a', 'account-a@example.com', '+4511000002', 'account');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, google: { connection: ids.google, userListId: '710001' } });
    expect((await syncNow(sync))[0]).toMatchObject({ platform: 'google', added: 1 });
    expect(membersOf('google', '710001', '1111111111')).toHaveLength(1);

    // Rotate the connection to a different customerId without republishing the sync.
    await api().call('connections.update', {
      id: ids.google,
      settings: {
        customerId: '2222222222',
        apiBase: platformUrl,
        reportingBase: platformUrl,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
    });
    const [result] = await syncNow(sync);
    expect(result).toMatchObject({ platform: 'google', status: 'ok', added: 1, removed: 1, members: 1 });
    // The old account is cleaned with the stored account id, never with the new mutable setting.
    expect(received.find((r) => r.path.endsWith(':remove'))?.account).toBe('1111111111');
    expect(membersOf('google', '710001', '1111111111')).toHaveLength(0);
    expect(membersOf('google', '710001', '2222222222')).toHaveLength(1);
  });
});

describe('durable intents survive an ambiguous write and a later erasure (#401 P1)', () => {
  it('removes a hash whose add was applied but whose ledger write failed', async () => {
    const segment = await createSegment('db-failure');
    const profile = await person('db-failure-a', 'db-failure-a@example.com', '+4511000101', 'db-failure');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000201' } });
    const flaky = ledgerFailureDb();
    afterApply = () => flaky.failNext();

    const [failed] = await syncAudience(flaky.db, ws, sync, defOf(segment, { meta: { connection: ids.meta, audienceId: '90000201' } }), {
      kp: t.srv.keyProvider,
      egress: t.srv.egress,
    });
    expect(failed.status).toBe('error');
    expect(membersOf('meta', '90000201')).toHaveLength(1);
    const intents = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audience_write_intents WHERE workspace_id = $1 AND sync_id = $2`,
      [ws, sync],
    );
    expect(intents.rows[0]!.n).toBe(1);

    await api().call('profiles.erase', { profileId: profile, reason: 'Erasure request (ledger failure test)' });
    const [cleaned] = await syncNow(sync);
    expect(cleaned).toMatchObject({ status: 'ok', members: 0 });
    expect(membersOf('meta', '90000201')).toHaveLength(0);
    const left = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audience_write_intents WHERE workspace_id = $1 AND sync_id = $2`,
      [ws, sync],
    );
    expect(left.rows[0]!.n).toBe(0);
  });

  it('removes a hash when the provider applied the add but the response was lost', async () => {
    const segment = await createSegment('timeout');
    const profile = await person('timeout-a', 'timeout-a@example.com', '+4511000102', 'timeout');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000202' } });
    failAddAfterApply = 'destroy';
    const [ambiguous] = await syncAudience(t.srv.db, ws, sync, defOf(segment, { meta: { connection: ids.meta, audienceId: '90000202' } }), {
      kp: t.srv.keyProvider,
      egress: t.srv.egress,
    });
    expect(ambiguous.status).toBe('error');
    expect(membersOf('meta', '90000202')).toHaveLength(1);

    await api().call('profiles.erase', { profileId: profile, reason: 'Erasure request (timeout test)' });
    const [cleaned] = await syncNow(sync);
    expect(cleaned).toMatchObject({ status: 'ok', members: 0 });
    expect(membersOf('meta', '90000202')).toHaveLength(0);
  });
});

describe('concurrency fencing', () => {
  it('skips a concurrent run of the same sync instead of racing the ledger', async () => {
    const segment = await createSegment('concurrent');
    const profile = await person('concurrent-a', 'concurrent-a@example.com', '+4511000401', 'concurrent');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000403' } });
    const def = defOf(segment, { meta: { connection: ids.meta, audienceId: '90000403' } });
    const deps = { kp: t.srv.keyProvider, egress: t.srv.egress };
    const otherSync = await createSync({ segment, meta: { connection: ids.meta2, audienceId: '90000403' } });
    const otherDef = defOf(segment, { meta: { connection: ids.meta2, audienceId: '90000403' } });

    holdAdds = true;
    let reached: () => void;
    const seen = new Promise<void>((resolve) => {
      reached = resolve;
    });
    addReached = reached!;
    const first = syncAudience(t.srv.db, ws, sync, def, deps);
    await seen;
    const second = await syncAudience(t.srv.db, ws, sync, def, deps);
    expect(second[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/already running/i) });
    const other = await syncAudience(t.srv.db, ws, otherSync, otherDef, deps);
    expect(other[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/already running/i) });
    releaseAdd!();
    holdAdds = false;
    const [firstResult] = await first;
    expect(firstResult).toMatchObject({ status: 'ok', added: 1, members: 1 });
  });
});

describe('cleanup independent of publication (#400 P1)', () => {
  it('cleans an erasure after the sync was unpublished', async () => {
    const segment = await createSegment('unpublished');
    const profile = await person('unpublished-a', 'unpublished-a@example.com', '+4511000201', 'unpublished');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000301' } });
    expect((await syncNow(sync))[0]).toMatchObject({ added: 1 });
    await t.srv.db.admin.query(`UPDATE artifacts SET published_version = NULL WHERE workspace_id = $1 AND id = $2`, [ws, sync]);
    await api().call('profiles.erase', { profileId: profile, reason: 'Erasure request (unpublished test)' });

    const { cleanup } = await api().call('ads.audiences', {});
    expect(cleanup.find((c) => c.syncId === sync && c.platform === 'meta')).toMatchObject({ members: 1 });
    const round = await runAudienceSyncRound({ db: t.srv.db, kp: t.srv.keyProvider, egress: t.srv.egress });
    expect(round.failures).toBe(0);
    expect(membersOf('meta', '90000301')).toHaveLength(0);
  });

  it('cleans every recorded member after the sync artifact was deleted', async () => {
    const segment = await createSegment('deleted');
    const profile = await person('deleted-a', 'deleted-a@example.com', '+4511000202', 'deleted');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000302' } });
    expect((await syncNow(sync))[0]).toMatchObject({ added: 1 });
    await t.srv.db.admin.query(`DELETE FROM artifacts WHERE workspace_id = $1 AND id = $2`, [ws, sync]);
    await api().call('profiles.erase', { profileId: profile, reason: 'Erasure request (deleted test)' });

    const round = await runAudienceSyncRound({ db: t.srv.db, kp: t.srv.keyProvider, egress: t.srv.egress });
    expect(round.failures).toBe(0);
    expect(membersOf('meta', '90000302')).toHaveLength(0);
  });

  it('keeps a disabled connection visible instead of claiming cleanup succeeded', async () => {
    const segment = await createSegment('disabled');
    const profile = await person('disabled-a', 'disabled-a@example.com', '+4511000203', 'disabled');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta2, audienceId: '90000303' } });
    expect((await syncNow(sync))[0]).toMatchObject({ added: 1 });
    await api().call('connections.update', { id: ids.meta2, enabled: false });
    const [blocked] = await syncNow(sync);
    expect(blocked.status).toBe('error');
    expect(blocked.error).toMatch(/disabled/i);
    expect(blocked.unresolved).toBeGreaterThan(0);
    expect((await api().call('ads.audienceBacklog', { syncId: sync })).total).toBeGreaterThan(0);
    expect(membersOf('meta', '90000303')).toHaveLength(1);

    await api().call('profiles.erase', { profileId: profile, reason: 'Erasure request (disabled test)' });
    await api().call('connections.update', { id: ids.meta2, enabled: true });
    const [cleaned] = await syncNow(sync);
    expect(cleaned).toMatchObject({ status: 'ok', removed: 1, members: 0 });
    expect(membersOf('meta', '90000303')).toHaveLength(0);
  });
});

describe('shared destination and profile merges', () => {
  it('does not delete a member another sync still owns at the same destination', async () => {
    const segmentA = await createSegment('shared-a', true);
    const segmentB = await createSegment('shared-b', true);
    const profile = await person('shared-a', 'shared-a@example.com', '+4511000301', 'shared');
    await api().call('audiences.add', { segmentId: segmentA, profileIds: [profile] });
    await api().call('audiences.add', { segmentId: segmentB, profileIds: [profile] });
    const syncA = await createSync({ segment: segmentA, meta: { connection: ids.meta, audienceId: '90000401' } });
    const syncB = await createSync({ segment: segmentB, meta: { connection: ids.meta2, audienceId: '90000401' } });
    expect((await syncNow(syncA))[0]).toMatchObject({ added: 1 });
    expect((await syncNow(syncB))[0]).toMatchObject({ added: 1 });
    expect(membersOf('meta', '90000401')).toHaveLength(1);

    await api().call('audiences.remove', { segmentId: segmentA, profileIds: [profile] });
    await syncNow(syncA);
    // Sync A no longer wants the person, but sync B does; the shared remote member must stay.
    expect(membersOf('meta', '90000401')).toHaveLength(1);
    const stillB = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audience_members WHERE workspace_id = $1 AND sync_id = $2`,
      [ws, syncB],
    );
    expect(stillB.rows[0]!.n).toBe(1);

    await api().call('audiences.remove', { segmentId: segmentB, profileIds: [profile] });
    await syncNow(syncB);
    expect(membersOf('meta', '90000401')).toHaveLength(0);
  });

  it('does not evacuate Meta when only the spend-import account changes', async () => {
    const segment = await createSegment('spend-setting');
    const profile = await person('spend-setting', 'spend-setting@example.com', '+4511000901', 'spend-setting');
    await addToSegment(segment, profile);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000406' } });
    await syncNow(sync);
    const before = received.length;
    await api().call('connections.update', { id: ids.meta, settings: { pixelId: '123456789', apiBase: platformUrl } });
    const [result] = await syncNow(sync);
    expect(result).toMatchObject({ status: 'ok', added: 0, removed: 0, members: 1 });
    expect(received.slice(before).filter((r) => r.path.includes('90000406'))).toHaveLength(0);
    expect(membersOf('meta', '90000406')).toHaveLength(1);
  });

  for (const mode of ['member', 'intent'] as const)
    it(`retains a partial shared-hash ${mode} cleanup obligation`, async () => {
      const segment = await createSegment(`partial-${mode}`);
      const profile = await person(
        `partial-${mode}`,
        `partial-${mode}@example.com`,
        mode === 'member' ? '+4511000402' : '+4511000403',
        `partial-${mode}`,
      );
      const other = await person(`owner-${mode}`, `owner-${mode}@example.com`, mode === 'member' ? '+4511000404' : '+4511000405', 'owner');
      await addToSegment(segment, profile);
      const audienceId = mode === 'member' ? '90000404' : '90000405';
      const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId } });
      const otherSync = await createSync({ segment, meta: { connection: ids.meta2, audienceId } });
      await syncNow(sync);
      // Seed the historical state after this e-mail was reassigned to another consenting profile:
      // that row owns the email only, never the erased person's phone.
      await t.srv.db.admin.query(
        `INSERT INTO audience_members
      (workspace_id, sync_id, platform, destination_key, connection_id, destination_id, operating_account_id,
       login_account_id, destination_known, profile_id, hashes)
      SELECT workspace_id, $3, platform, destination_key, connection_id, destination_id, operating_account_id,
       login_account_id, destination_known, $4, jsonb_build_object('email', hashes->>'email')
      FROM audience_members WHERE workspace_id = $1 AND sync_id = $2`,
        [ws, sync, otherSync, other],
      );
      if (mode === 'intent') {
        await t.srv.db.admin.query(
          `INSERT INTO audience_write_intents
        (workspace_id, sync_id, platform, destination_key, connection_id, destination_id, operating_account_id,
         login_account_id, profile_id, op, hashes)
        SELECT workspace_id, sync_id, platform, destination_key, connection_id, destination_id, operating_account_id,
         login_account_id, profile_id, 'add', hashes FROM audience_members WHERE workspace_id = $1 AND sync_id = $2`,
          [ws, sync],
        );
        await t.srv.db.admin.query('DELETE FROM audience_members WHERE workspace_id = $1 AND sync_id = $2', [ws, sync]);
      }
      await api().call('profiles.erase', { profileId: profile, reason: 'Partial ownership regression' });
      const [result] = await syncNow(sync);
      expect(result.status).toBe('error');
      expect(result.unresolved).toBeGreaterThan(0);
      expect(result.error).toMatch(/partially overlap/);
      const backlog = await api().call('ads.audienceBacklog', { syncId: sync });
      expect(backlog.entries.some((e) => e.kind === mode)).toBe(true);
      expect(membersOf('meta', audienceId)).toHaveLength(1);
      expect(membersOf('meta', audienceId)[0]!.phone).toBeTruthy();
    });

  it('keeps the survivor in the remote audience when two profiles merge', async () => {
    const segment = await createSegment('merge');
    // Complementary identities can merge; two different user ids/emails/phones must not.
    await send([{ type: 'identify', userId: 'merge-a', traits: { phone: '+4511000302', plan: 'merge' } }]);
    await send([{ type: 'identify', anonymousId: 'merge-b-device', traits: { email: 'merge-b@example.com', plan: 'merge' } }]);
    const survivor = (
      await eventually(
        () => api().call('profiles.find', { type: 'user_id', value: 'merge-a' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    const mergedAway = (
      await eventually(
        () => api().call('profiles.find', { type: 'anonymous_id', value: 'merge-b-device' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    for (const profileId of [survivor, mergedAway]) {
      await api().call('consent.record', { profileId, purpose: 'ad_targeting', status: 'granted', source: 'api', proof: { test: true } });
    }
    await t.srv.db.admin.query(
      `UPDATE profiles SET created_at = CASE WHEN id = $2 THEN '2020-01-01'::timestamptz ELSE '2021-01-01'::timestamptz END WHERE workspace_id = $1 AND id = ANY($3::text[])`,
      [ws, survivor, [survivor, mergedAway]],
    );
    await addToSegment(segment, survivor);
    await addToSegment(segment, mergedAway);
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000402' } });
    expect((await syncNow(sync))[0]).toMatchObject({ added: 2, members: 2 });
    expect(membersOf('meta', '90000402')).toHaveLength(2);

    // Link the anonymous identity to the known user; oldest profile survives.
    await send([{ type: 'identify', userId: 'merge-a', anonymousId: 'merge-b-device', traits: { plan: 'merge' } }]);
    const merged = await eventually(
      () =>
        t.srv.db.admin.query<{ merged_into: string | null }>(`SELECT merged_into FROM profiles WHERE workspace_id = $1 AND id = $2`, [
          ws,
          mergedAway,
        ]),
      (r) => !!r.rows[0]?.merged_into,
    );
    expect(merged.rows[0]!.merged_into).toBe(survivor);

    const [result] = await syncAudience(t.srv.db, ws, sync, defOf(segment, { meta: { connection: ids.meta, audienceId: '90000402' } }), {
      kp: t.srv.keyProvider,
      egress: t.srv.egress,
      maxReconcilePerRun: 0,
    });
    expect(result.status).toBe('ok');
    const remaining = membersOf('meta', '90000402');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual({ email: metaEmail('merge-b@example.com'), phone: metaPhone('+4511000302') });
    const survivorRow = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audience_members WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = $3`,
      [ws, sync, survivor],
    );
    expect(survivorRow.rows[0]!.n).toBe(1);
  });
});

describe('bounded legacy recovery and human acknowledgement (#400 P1)', () => {
  it('inspects and acknowledges a legacy cleanup with a note and audit hash', async () => {
    const segment = await createSegment('legacy-ack');
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000501' } });
    await t.srv.db.admin.query(
      `INSERT INTO audience_members
         (workspace_id, sync_id, platform, destination_key, destination_known, profile_id, hashes, orphaned_at, orphaned_reason)
       VALUES ($1, $2, 'meta', 'legacy:unknown', false, 'prf_00000000000000000000000000000001', $3::jsonb, now(), 'uploaded before 0.7.4: destination was not recorded')`,
      [ws, sync, JSON.stringify({ email: metaEmail('legacy-ack@example.com') })],
    );
    const [result] = await syncNow(sync);
    expect(result.status).toBe('error');
    expect(result.unresolved).toBeGreaterThanOrEqual(1);

    const backlog = await api().call('ads.audienceBacklog', { syncId: sync, limit: 50 });
    expect(backlog.total).toBe(1);
    expect(backlog.entries[0]).toMatchObject({ kind: 'member', syncId: sync, platform: 'meta', destinationKey: 'legacy:unknown' });
    expect(JSON.stringify(backlog.entries[0])).not.toMatch(/email|phone|prf_/i);

    const command = adAudienceCommands.find((c) => c.name === 'ads.acknowledgeAudienceCleanup');
    expect(command?.humansOnly).toBe(true);
    await expect(
      api().call('ads.acknowledgeAudienceCleanup', { syncId: sync, cleanupIds: [backlog.entries[0]!.cleanupId], note: '   ' }),
    ).rejects.toThrow();
    await expect(
      api().call('ads.acknowledgeAudienceCleanup', {
        syncId: sync,
        cleanupIds: ['00000000-0000-0000-0000-000000000000'],
        note: 'Cleaned in Ads Manager',
      }),
    ).rejects.toThrow(/not in this sync/i);

    const acknowledged = await api().call('ads.acknowledgeAudienceCleanup', {
      syncId: sync,
      cleanupIds: [backlog.entries[0]!.cleanupId],
      note: 'Removed the legacy audience member in Ads Manager on 2026-11-04',
    });
    expect(acknowledged).toMatchObject({ acknowledged: 1, remaining: 0 });
    expect((await api().call('ads.audienceBacklog', { syncId: sync, limit: 50 })).total).toBe(0);
    const audit = await t.srv.db.admin.query<{ input_hash: string }>(
      `SELECT input_hash FROM audit_log WHERE workspace_id = $1 AND command = 'ads.acknowledgeAudienceCleanup' AND ok ORDER BY seq DESC LIMIT 1`,
      [ws],
    );
    expect(audit.rows[0]!.input_hash.length).toBeGreaterThan(20);
  });
});

describe('bounded progress and scheduler isolation', () => {
  it('does not let a 65,536-row legacy group abort the round or starve another sync (#400 P1)', async () => {
    const segment = await createSegment('round-ok');
    const profile = await person('round-ok-a', 'round-ok-a@example.com', '+4511000601', 'round-ok');
    await addToSegment(segment, profile);
    const goodSync = await createSync({ segment, meta: { connection: ids.meta, audienceId: '90000601' } });

    const legacySegment = await createSegment('round-legacy');
    const legacySync = await createSync({ segment: legacySegment, meta: { connection: ids.meta, audienceId: '90000602' } });
    await t.srv.db.admin.query(
      `INSERT INTO audience_members (workspace_id, sync_id, platform, destination_key, destination_known, profile_id, hashes)
       SELECT $1, $2, 'meta', 'legacy:unknown', false,
              'prf_' || lpad(to_hex(g), 32, '0'), jsonb_build_object('email', 'legacy-' || g)
       FROM generate_series(1, 65536) g`,
      [ws, legacySync],
    );

    const round = await runAudienceSyncRound({ db: t.srv.db, kp: t.srv.keyProvider, egress: t.srv.egress });
    expect(round.failures).toBe(0);
    expect(membersOf('meta', '90000601')).toHaveLength(1);
    const state = await t.srv.db.admin.query<{ status: string; unresolved: number }>(
      `SELECT status, unresolved FROM audience_sync_state WHERE workspace_id = $1 AND sync_id = $2 AND platform = 'meta'`,
      [ws, legacySync],
    );
    expect(state.rows[0]).toMatchObject({ status: 'error' });
    expect(state.rows[0]!.unresolved).toBe(65536);
    expect((await syncNow(goodSync))[0]).toMatchObject({ status: 'ok', members: 1 });
  }, 120_000);
});

describe('merge restore covers every prior hash and intent', () => {
  for (const mode of ['stale', 'intent', 'loser-intent'] as const)
    it(`preserves ${mode} survivor coverage during immediate restore`, async () => {
      const modeNumber = ['stale', 'intent', 'loser-intent'].indexOf(mode);
      const segment = await createSegment(`covered-${mode}`, true);
      const survivor = await person(`cover-${mode}`, `cover-${mode}@example.com`, `+45110008${21 + modeNumber}`, 'covered');
      const loser = await person(`lose-${mode}`, `lose-${mode}@example.com`, `+45110008${31 + modeNumber}`, 'covered');
      await api().call('audiences.add', { segmentId: segment, profileIds: [survivor, loser] });
      const audienceId = String(90000821 + modeNumber);
      const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId } });
      await syncNow(sync);
      const old = { email: `historical-${mode}`, phone: `historical-phone-${mode}` };
      if (mode === 'stale') {
        await t.srv.db.admin.query(
          `UPDATE audience_members SET hashes = $3::jsonb WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = $4`,
          [ws, sync, JSON.stringify(old), survivor],
        );
        const member = membersOf('meta', audienceId).find((r) => r.email === metaEmail(`cover-${mode}@example.com`))!;
        Object.assign(member, old);
      } else {
        const owner = await person(`shared-owner-${mode}`, `shared-owner-${mode}@example.com`, `+45110008${41 + modeNumber}`, 'owner');
        const intentProfile = mode === 'loser-intent' ? loser : survivor;
        const otherSync = await createSync({ segment, meta: { connection: ids.meta2, audienceId } });
        // Historical ambiguous upload of both hashes; another row owns only the e-mail.
        await t.srv.db.admin.query(
          `INSERT INTO audience_write_intents (workspace_id, sync_id, platform, destination_key, connection_id, destination_id, operating_account_id, login_account_id, profile_id, op, hashes, orphaned_at, orphaned_reason)
        SELECT workspace_id, sync_id, platform, destination_key, connection_id, destination_id, operating_account_id, login_account_id, profile_id, 'add', $4::jsonb, now(), 'partial shared cleanup'
        FROM audience_members WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = $3`,
          [ws, sync, intentProfile, JSON.stringify(old)],
        );
        await t.srv.db.admin.query(
          `INSERT INTO audience_members (workspace_id, sync_id, platform, destination_key, connection_id, destination_id, operating_account_id, login_account_id, destination_known, profile_id, hashes)
        SELECT workspace_id, $4, platform, destination_key, connection_id, destination_id, operating_account_id, login_account_id, true, $5, $6::jsonb
        FROM audience_members WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = $3`,
          [ws, sync, survivor, otherSync, owner, JSON.stringify({ email: old.email })],
        );
        upsertMember(keyOf('meta', audienceId), old);
      }
      // Snapshot the merge tombstone at this seam. Actual resolver merge behavior is covered above.
      await t.srv.db.admin.query('UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2', [ws, loser, survivor]);
      const [result] = await syncAudience(t.srv.db, ws, sync, defOf(segment, { meta: { connection: ids.meta, audienceId } }), {
        kp: t.srv.keyProvider,
        egress: t.srv.egress,
        maxReconcilePerRun: 0,
        maxAddsPerRun: 0,
      });
      if (mode === 'stale') {
        expect(result.status).toBe('ok');
        expect(membersOf('meta', audienceId)).toHaveLength(1);
        expect(membersOf('meta', audienceId)[0]!.email).toBe(metaEmail('cover-stale@example.com'));
        await api().call('profiles.erase', { profileId: survivor, reason: 'Stale survivor coverage test' });
        await syncNow(sync);
        expect(membersOf('meta', audienceId)).toHaveLength(0);
      } else {
        expect(result.status).toBe('error');
        const pending = await t.srv.db.admin.query<{ hashes: unknown; orphaned_at: unknown }>(
          'SELECT hashes, orphaned_at FROM audience_write_intents WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = $3',
          [ws, sync, mode === 'loser-intent' ? loser : survivor],
        );
        expect(pending.rows).toHaveLength(1);
        expect(pending.rows[0]!.hashes).toEqual(old);
        expect(pending.rows[0]!.orphaned_at).toBeTruthy();
      }
    });

  it('advances the reconcile cursor past a manual obligation to later members', async () => {
    const segment = await createSegment('partial-progress', true);
    const blocked = await person('progress-a', 'progress-a@example.com', '+4511000811', 'progress');
    const later = await person('progress-b', 'progress-b@example.com', '+4511000812', 'progress');
    const owner = await person('progress-owner', 'progress-owner@example.com', '+4511000813', 'owner');
    expect(blocked < later).toBe(true);
    await api().call('audiences.add', { segmentId: segment, profileIds: [blocked, later] });
    const audienceId = '90000804';
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId } });
    const otherSync = await createSync({ segment, meta: { connection: ids.meta2, audienceId } });
    await syncNow(sync);
    const oldBlocked = { email: 'progress-shared', phone: 'progress-private' };
    const oldLater = { email: 'progress-old-later', phone: 'progress-old-phone' };
    await t.srv.db.admin.query(
      `UPDATE audience_members SET hashes = CASE WHEN profile_id = $3 THEN $5::jsonb ELSE $6::jsonb END WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = ANY($4::text[])`,
      [ws, sync, blocked, [blocked, later], JSON.stringify(oldBlocked), JSON.stringify(oldLater)],
    );
    await t.srv.db.admin.query(
      `INSERT INTO audience_members (workspace_id, sync_id, platform, destination_key, connection_id, destination_id, operating_account_id, login_account_id, destination_known, profile_id, hashes)
      SELECT workspace_id, $4, platform, destination_key, connection_id, destination_id, operating_account_id, login_account_id, true, $5, $6::jsonb
      FROM audience_members WHERE workspace_id = $1 AND sync_id = $2 AND profile_id = $3`,
      [ws, sync, blocked, otherSync, owner, JSON.stringify({ email: oldBlocked.email })],
    );
    remote.set(keyOf('meta', audienceId), [oldBlocked, oldLater]);
    const deps = { kp: t.srv.keyProvider, egress: t.srv.egress, maxReconcilePerRun: 1, maxAddsPerRun: 0 };
    const def = defOf(segment, { meta: { connection: ids.meta, audienceId } });
    await syncAudience(t.srv.db, ws, sync, def, deps);
    await syncAudience(t.srv.db, ws, sync, def, deps);
    expect(membersOf('meta', audienceId).some((m) => m.email === metaEmail('progress-b@example.com'))).toBe(true);
    expect((await api().call('ads.audienceBacklog', { syncId: sync })).total).toBe(1);
  });

  it('does not remove the current member when retrying an old connection at the same Meta audience', async () => {
    const segment = await createSegment('same-target', true);
    const profile = await person('same-target', 'same-target@example.com', '+4511000806', 'same-target');
    await api().call('audiences.add', { segmentId: segment, profileIds: [profile] });
    const audienceId = '90000803';
    const sync = await createSync({ segment, meta: { connection: ids.meta, audienceId } });
    await syncNow(sync);
    await updateSync(sync, defOf(segment, { meta: { connection: ids.meta2, audienceId } }) as unknown as Record<string, unknown>);
    failRemoveAfterApply = 'http500';
    expect((await syncNow(sync))[0]!.status).toBe('error');
    expect(membersOf('meta', audienceId)).toHaveLength(1);
    expect((await syncNow(sync))[0]!.status).toBe('ok');
    expect(membersOf('meta', audienceId)).toHaveLength(1);
  });
});

describe('bounded cleanup discovery', () => {
  it('advances bounded scheduler pages across every candidate and wraps after the pass', async () => {
    const db = { ...t.srv.db }; // Independent scheduler cursor; same real database.
    const expected = await t.srv.db.admin.query<{ workspace_id: string; sync_id: string }>(
      `SELECT workspace_id, id AS sync_id FROM artifacts WHERE type = 'audience_sync' AND published_version IS NOT NULL UNION SELECT workspace_id, sync_id FROM audience_members UNION SELECT workspace_id, sync_id FROM audience_write_intents UNION SELECT workspace_id, sync_id FROM audience_sync_state ORDER BY workspace_id, sync_id`,
    );
    const found: string[] = [];
    for (let i = 0; i <= expected.rows.length; i++) {
      const page = await selectAudienceSyncRound(db, 2);
      expect(page.length).toBeLessThanOrEqual(2);
      if (!page.length) break;
      found.push(...page.map((r) => `${r.workspace_id}:${r.sync_id}`));
    }
    expect(found).toEqual(expected.rows.map((r) => `${r.workspace_id}:${r.sync_id}`));
    expect((await selectAudienceSyncRound(db, 2))[0]).toEqual(expected.rows[0]);
  });

  it('pages all cleanup summaries beyond the 200-sync cap', async () => {
    await t.srv.db.admin.query(
      `INSERT INTO audience_sync_state (workspace_id, sync_id, platform, status) SELECT $1, 'aud_' || lpad(n::text, 32, '0'), 'meta', 'ok' FROM generate_series(1, 205) n ON CONFLICT DO NOTHING`,
      [ws],
    );
    const seen = new Set<string>();
    let cleanupAfter: string | undefined;
    let total = 0;
    for (let page = 0; page < 5; page++) {
      const result = await api().call('ads.audiences', { cleanupAfter });
      total = result.cleanupTotal;
      for (const row of result.cleanup) seen.add(row.syncId);
      if (!result.cleanupNext) break;
      cleanupAfter = result.cleanupNext;
    }
    expect(total).toBeGreaterThanOrEqual(205);
    expect(seen.size).toBe(total);
  });
});
