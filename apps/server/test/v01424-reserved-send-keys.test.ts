import { holdoutHashVersion } from '@agentic-marketing/artifacts';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #945: a holdout-control row and a real send for one person in one broadcast shared the key shape
// `bct:<broadcast>:<profile>` with different fingerprints, so a control group that changed mid-run
// made the gateway answer `idempotency_key_reused` — which the run loop did not catch, rolling back
// the batch and failing every later tick on the same member. The control row now has the `bctc:`
// namespace, the system prefixes are refused as caller-supplied send keys, and one member's key
// conflict is recorded as a failed send instead of stopping the run.

const PORT = testPort(3504);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let template = '';
let mcp: Client;

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const api = () => t.api(owner, ws);

const post = async (command: string, body: unknown) => {
  const res = await fetch(`${t.base}/v1/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': ws },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; message?: string; details?: unknown } };
};

const ingest = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const createPublished = async (type: 'email_template' | 'segment' | 'broadcast' | 'campaign', name: string, content: object) => {
  const a = await api().call('artifacts.create', { type, name, content });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'v01424 reserved keys' });
  return a.artifactId;
};

const profileOf = async (userId: string) =>
  (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    )
  ).profileId!;

interface MessageRow {
  id: string;
  profile_id: string | null;
  idempotency_key: string;
  status: string;
  reason: string | null;
}

const messagesOf = async (broadcastId: string): Promise<MessageRow[]> =>
  (
    await t.srv.db.admin.query<MessageRow>(
      `SELECT id, profile_id, idempotency_key, status, reason FROM messages
       WHERE workspace_id = $1 AND journey_id = $2 AND test = false ORDER BY profile_id, id`,
      [ws, broadcastId],
    )
  ).rows;

const runStatus = async (broadcastId: string) =>
  (
    await t.srv.db.admin.query<{ status: string }>('SELECT status FROM broadcast_runs WHERE workspace_id = $1 AND broadcast_id = $2', [
      ws,
      broadcastId,
    ])
  ).rows[0]!.status;

/** A static list, a broadcast due only when the test says so, and its four people. */
async function broadcastFor(name: string, userIds: string[]) {
  const profiles: string[] = [];
  for (const userId of userIds) {
    await ingest([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    profiles.push(await profileOf(userId));
    await api().call('consent.record', { profileId: profiles.at(-1)!, purpose: 'marketing_email', status: 'granted' });
  }
  const segment = await createPublished('segment', `reserved keys ${name}`, { mode: 'static' });
  await api().call('audiences.add', { segmentId: segment, profileIds: profiles });
  const id = await createPublished('broadcast', `reserved keys ${name}`, {
    template,
    segment,
    sendAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await eventually(
    async () =>
      (await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM broadcast_runs WHERE broadcast_id = $1', [id])).rows[0]!.n,
    (n) => n === 1,
  );
  return { id, segment, profiles };
}

const due = (broadcastId: string, cursor = '') =>
  t.srv.db.admin.query(
    `UPDATE broadcast_runs SET send_at = now() - interval '1 minute', status = 'running', cursor = $2, lease_until = NULL
     WHERE workspace_id = $1 AND broadcast_id = $3`,
    [ws, cursor, broadcastId],
  );

const awaitDone = (broadcastId: string) =>
  eventually(
    () => runStatus(broadcastId),
    (s) => s === 'done',
    20_000,
  );

const campaignContent = (broadcastId: string, controlGroup?: { percent: number; reset?: boolean }) => ({
  startsAt: '2026-01-01T00:00:00.000Z',
  goal: { kind: 'conversion', event: 'Order Completed', attributionDays: 7 },
  ...(controlGroup ? { controlGroup: { ...controlGroup, minSampleSize: 1 } } : {}),
  members: [{ artifactId: broadcastId, role: 'primary' }],
});

beforeAll(async () => {
  t = await startTestServer('test_v01424_reserved_keys', PORT);
  owner = await t.signUp(`owner-reserved-keys-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('emailProviders.create', {
    name: 'Relay',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  template = await createPublished('email_template', 'reserved keys newsletter', {
    purpose: 'marketing_email',
    subject: 'One key per send',
    mjml: mjml('Hello {{ profile.firstName | default: "reader" }}'),
  });
  const token = await api().call('apiTokens.create', {
    name: 'send client',
    scopes: ['messages:send', 'artifacts:read', 'artifacts:write'],
  });
  mcp = new Client({ name: 'reserved-keys-test', version: '1' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.token}` } },
    }),
  );
}, 120_000);

afterAll(async () => {
  await mcp?.close().catch(() => {});
  await t?.close();
});

describe('control rows and sends have their own keys (#945)', () => {
  it('keeps a control row in the bctc namespace', async () => {
    const { id, profiles } = await broadcastFor('control-key', ['ck-a']);
    // A campaign with a control group and this member assigned to control before the run reaches them.
    const campaign = await createPublished('campaign', 'control-key campaign', campaignContent(id, { percent: 50 }));
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm)
       VALUES ($1, 'campaign', $2, $3, $4, 'control')`,
      [ws, campaign, holdoutHashVersion(50), profiles[0]],
    );
    await due(id);
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('suppressed');
    expect(rows[0]!.reason).toContain('holdout_control');
    expect(rows[0]!.idempotency_key).toBe(`bctc:${id}:${profiles[0]}`);
  }, 90_000);

  it('finishes a run whose control group changed mid-run, and sends the rest', async () => {
    const { id, segment, profiles } = await broadcastFor('control-change', ['cc-a', 'cc-b', 'cc-c', 'cc-d']);
    const campaign = await createPublished('campaign', 'control-change campaign', campaignContent(id, { percent: 50 }));
    // Two members control, two not, decided by the test rather than by the hash.
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm)
       VALUES ($1, 'campaign', $2, $3, $4, 'control'), ($1, 'campaign', $2, $3, $5, 'control'),
              ($1, 'campaign', $2, $3, $6, 'treatment'), ($1, 'campaign', $2, $3, $7, 'treatment')`,
      [ws, campaign, holdoutHashVersion(50), profiles[0], profiles[1], profiles[2], profiles[3]],
    );
    await due(id);
    await awaitDone(id);
    const first = await messagesOf(id);
    expect(first).toHaveLength(4);
    expect(first.filter((m) => m.status === 'suppressed').map((m) => m.profile_id)).toEqual([profiles[0], profiles[1]]);

    // The control group changes (a new scope), and the run is resumed from the top as
    // broadcasts.continue does: the two control members now look eligible, which used to answer
    // idempotency_key_reused and wedge every later tick.
    await api().call('artifacts.updateDraft', { artifactId: campaign, content: campaignContent(id, { percent: 1, reset: true }) });
    await api().call('artifacts.requestPublish', { artifactId: campaign, note: 'no control for the resumed run' });
    // Two more people join the audience while the run is between passes.
    const joined: string[] = [];
    for (const userId of ['cc-e', 'cc-f']) {
      await ingest([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
      const added = await profileOf(userId);
      await api().call('consent.record', { profileId: added, purpose: 'marketing_email', status: 'granted' });
      await api().call('audiences.add', { segmentId: segment, profileIds: [added] });
      joined.push(added);
    }
    // Everyone, including the newcomers, is treatment in the new scope, so the test's outcome does
    // not depend on the 1% bucket the percentage would otherwise leave to chance.
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm)
       SELECT $1, 'campaign', $2, $3, x, 'treatment' FROM unnest($4::text[]) AS x`,
      [ws, campaign, holdoutHashVersion(1), [...profiles, ...joined]],
    );
    // A resumed run starts from the top (the state broadcasts.continue leaves for a stopped stage;
    // it refuses a finished run, so the test puts it there itself).
    await due(id);
    await awaitDone(id);

    const all = await messagesOf(id);
    // One message per person; the earlier four keep the decision they already have.
    expect(all).toHaveLength(6);
    const perPerson = new Map<string, number>();
    for (const m of all) perPerson.set(m.profile_id!, (perPerson.get(m.profile_id!) ?? 0) + 1);
    expect([...perPerson.values()].every((n) => n === 1)).toBe(true);
    expect(all.filter((m) => m.status !== 'suppressed')).toHaveLength(4);
  }, 120_000);

  it('recognises a control row written under the old shared key and sends nothing', async () => {
    const { id, profiles } = await broadcastFor('old-control', ['oc-a']);
    // 0.14.23 wrote the control row as `bct:<broadcast>:<profile>`; there is no campaign at all now.
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, template_id, template_version,
                             journey_id, status, reason, request_hash)
       VALUES ($1, 'msg_oc_a', $2, 'email', $3, 'marketing_email', $4, 1, $5, 'suppressed',
               'holdout_control: campaign cmp_x holds this person out of every sending member', 'holdout-hash')`,
      [ws, `bct:${id}:${profiles[0]}`, profiles[0], template, id],
    );
    await due(id);
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('suppressed');
    expect(rows[0]!.idempotency_key).toBe(`bct:${id}:${profiles[0]}`);
  }, 90_000);

  it('records one member’s pre-claimed key as a failed send and still sends the rest', async () => {
    const { id, profiles } = await broadcastFor('preclaimed', ['pc-a', 'pc-b']);
    // A key a caller claimed before the system prefixes were reserved: its row is not this run's
    // message (no journey id), so the run asks for the key and the gateway refuses it.
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, status, request_hash)
       VALUES ($1, 'msg_pc_a', $2, 'email', $3, 'marketing_email', 'queued', 'someone-elses-hash')`,
      [ws, `bct:${id}:${profiles[0]}`, profiles[0]],
    );
    await due(id);
    await awaitDone(id);

    const rows = await messagesOf(id);
    const claimed = rows.filter((m) => m.profile_id === profiles[0]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe('failed');
    expect(claimed[0]!.reason).toContain('idempotency_conflict');
    const other = rows.filter((m) => m.profile_id === profiles[1]);
    expect(other).toHaveLength(1);
    expect(['queued', 'sending', 'sent', 'delivered']).toContain(other[0]!.status);
  }, 90_000);

  it('refuses a user key with a reserved prefix on every send command, REST and MCP', async () => {
    const { id, profiles } = await broadcastFor('refused', ['rf-a']);
    const speak = (details: unknown) => JSON.stringify(details);

    const email = await post('messages.sendEmail', {
      profileId: profiles[0],
      templateId: template,
      idempotencyKey: `bct:${id}:${profiles[0]}`,
    });
    expect(email.status).toBe(400);
    expect(email.body.error).toBe('invalid_input');
    expect(speak(email.body.details)).toContain('reserved system prefix');
    expect(speak(email.body.details)).toContain('bctc:');

    const sms = await post('messages.sendSms', {
      profileId: profiles[0],
      templateId: `sms_${'0'.repeat(32)}`,
      idempotencyKey: `jrn:${id}`,
    });
    expect(sms.status).toBe(400);
    expect(sms.body.error).toBe('invalid_input');
    expect(speak(sms.body.details)).toContain('reserved system prefix');

    const push = await post('messages.sendPush', {
      profileId: profiles[0],
      templateId: `psh_${'0'.repeat(32)}`,
      idempotencyKey: `doi:${id}`,
    });
    expect(push.status).toBe(400);
    expect(push.body.error).toBe('invalid_input');
    expect(speak(push.body.details)).toContain('reserved system prefix');

    const enroll = await post('journeys.enrollSegment', {
      artifactId: `jrn_${'0'.repeat(32)}`,
      segmentId: `seg_${'0'.repeat(32)}`,
      reason: 'reserved prefix test',
      idempotencyKey: `alert:${id}`,
    });
    expect(enroll.status).toBe(400);
    expect(enroll.body.error).toBe('invalid_input');
    expect(speak(enroll.body.details)).toContain('reserved system prefix');

    // Nothing was written under the reserved keys.
    const written = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND idempotency_key LIKE 'bct:%'
         AND profile_id = $2 AND journey_id IS NULL`,
      [ws, profiles[0]],
    );
    expect(written.rows[0]!.n).toBe(0);

    for (const [tool, args] of [
      ['messages.sendEmail', { profileId: profiles[0], templateId: template, idempotencyKey: `bct:${id}:${profiles[0]}` }],
      ['messages.sendSms', { profileId: profiles[0], templateId: `sms_${'0'.repeat(32)}`, idempotencyKey: 'jrn:1' }],
      ['messages.sendPush', { profileId: profiles[0], templateId: `psh_${'0'.repeat(32)}`, idempotencyKey: 'doi:1' }],
      [
        'journeys.enrollSegment',
        {
          artifactId: `jrn_${'0'.repeat(32)}`,
          segmentId: `seg_${'0'.repeat(32)}`,
          reason: 'reserved prefix test',
          idempotencyKey: 'alert:1',
        },
      ],
    ] as const) {
      const refused = await mcp.callTool({ name: tool, arguments: args as Record<string, unknown> });
      expect(refused.isError, tool).toBe(true);
      const text = (refused.content as { type: string; text: string }[])[0]!.text;
      expect(text, tool).toContain('reserved system prefix');
      expect(JSON.parse(text).error, tool).toBe('invalid_input');
    }

    // A caller's own key is accepted, and the broadcast afterwards sends this person normally.
    const own = await post('messages.sendEmail', { profileId: profiles[0], templateId: template, idempotencyKey: 'order-1234' });
    expect(own.status).toBe(200);
    await due(id);
    await awaitDone(id);
    const sent = await messagesOf(id);
    expect(sent).toHaveLength(1);
    expect(['queued', 'sending', 'sent', 'delivered']).toContain(sent[0]!.status);
  }, 120_000);
});
