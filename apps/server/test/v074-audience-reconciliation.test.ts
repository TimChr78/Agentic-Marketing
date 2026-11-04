import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { adAudienceCommands, metaEmail, metaPhone, runAudienceSyncRound, syncAudience } from '@agentic-marketing/ads';
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

async function createSegment(name: string) {
  const a = await api().call('artifacts.create', {
    type: 'segment',
    name: `Audience ${name}`,
    content: { condition: { trait: 'plan', op: 'eq', value: name } },
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
    const segmentA = await createSegment('shared-a');
    const segmentB = await createSegment('shared-b');
    const profile = await person('shared-a', 'shared-a@example.com', '+4511000301', 'shared');
    await addToSegment(segmentA, profile);
    await addToSegment(segmentB, profile);
    const syncA = await createSync({ segment: segmentA, meta: { connection: ids.meta, audienceId: '90000401' } });
    const syncB = await createSync({ segment: segmentB, meta: { connection: ids.meta, audienceId: '90000401' } });
    expect((await syncNow(syncA))[0]).toMatchObject({ added: 1 });
    expect((await syncNow(syncB))[0]).toMatchObject({ added: 1 });
    expect(membersOf('meta', '90000401')).toHaveLength(1);

    await t.srv.db.admin.query(`DELETE FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2 AND profile_id = $3`, [
      ws,
      segmentA,
      profile,
    ]);
    await syncNow(syncA);
    // Sync A no longer wants the person, but sync B does; the shared remote member must stay.
    expect(membersOf('meta', '90000401')).toHaveLength(1);
    const stillB = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audience_members WHERE workspace_id = $1 AND sync_id = $2`,
      [ws, syncB],
    );
    expect(stillB.rows[0]!.n).toBe(1);

    await t.srv.db.admin.query(`DELETE FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2 AND profile_id = $3`, [
      ws,
      segmentB,
      profile,
    ]);
    await syncNow(syncB);
    expect(membersOf('meta', '90000401')).toHaveLength(0);
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

    const [result] = await syncNow(sync);
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
