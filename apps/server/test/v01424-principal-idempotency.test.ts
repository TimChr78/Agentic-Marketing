import { callerHash, defineCommand, userPrincipal } from '@agentic-marketing/commands';
import { requestEmail, requestPush, requestSms, sendRequestHash } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { eventually, startTestServer, testPort, type User } from './harness';

// #906 review round 2 (A1): an idempotency key is scoped to the caller as well as the workspace.
// Before, the lookup keyed only on (workspace, key), so a different principal presenting the same
// key received the first caller's stored response instead of a conflict.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
let otherWs: string;
let tokenA: string;
let tokenB: string;

const note = (name: string) => ({ type: 'note', name, content: { title: name, body: 'x' } });

const call = (
  headers: Record<string, string>,
  command: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: { artifactId?: string; error?: string; details?: { reason?: string } } }> =>
  fetch(`${t.base}/v1/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

const asPerson = (workspaceId: string) => ({ cookie: owner.cookie, origin: t.base, 'x-workspace-id': workspaceId });
const asToken = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  t = await startTestServer('test_v01424_principal_idempotency', testPort(3486));
  owner = await t.signUp(`principal-idempotency-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  otherWs = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  tokenA = (await api.call('apiTokens.create', { name: 'agent A', scopes: ['artifacts:read', 'artifacts:write'] })).token;
  tokenB = (await api.call('apiTokens.create', { name: 'agent B', scopes: ['artifacts:read', 'artifacts:write'] })).token;
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('an idempotency key is bound to its principal (A1)', () => {
  it('replays for the same person, including another session', async () => {
    const first = await call(asPerson(ws), 'artifacts.create', note('Same person'), 'same-person-1');
    const replay = await call(asPerson(ws), 'artifacts.create', note('Same person'), 'same-person-1');
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.artifactId).toBe(first.body.artifactId);
  });

  it('replays for the same agent token', async () => {
    const first = await call(asToken(tokenA), 'artifacts.create', note('Same agent'), 'same-agent-1');
    const replay = await call(asToken(tokenA), 'artifacts.create', note('Same agent'), 'same-agent-1');
    expect(first.status).toBe(200);
    expect(replay.body.artifactId).toBe(first.body.artifactId);
  });

  it('refuses the same key from a person and an agent', async () => {
    const first = await call(asPerson(ws), 'artifacts.create', note('Person first'), 'shared-person-agent');
    expect(first.status).toBe(200);
    const agent = await call(asToken(tokenA), 'artifacts.create', note('Person first'), 'shared-person-agent');
    expect(agent.status).toBe(409);
    expect(agent.body.details?.reason).toBe('idempotency_key_reused');
    // The agent did not get the person's response and did not create a second artifact.
    expect(agent.body.artifactId).toBeUndefined();
    const list = await t.api(owner, ws).call('artifacts.list', { type: 'note', limit: 100 });
    expect(list.artifacts.filter((a) => a.name === 'Person first')).toHaveLength(1);
  });

  it('refuses the same key from two different agent tokens', async () => {
    const first = await call(asToken(tokenA), 'artifacts.create', note('Agent A first'), 'shared-agent-agent');
    expect(first.status).toBe(200);
    const second = await call(asToken(tokenB), 'artifacts.create', note('Agent A first'), 'shared-agent-agent');
    expect(second.status).toBe(409);
    expect(second.body.details?.reason).toBe('idempotency_key_reused');
    expect(second.body.artifactId).toBeUndefined();
  });

  it('keeps the same key independent across two workspaces', async () => {
    const a = await call(asPerson(ws), 'artifacts.create', note('Workspace A'), 'cross-workspace');
    const b = await call(asPerson(otherWs), 'artifacts.create', note('Workspace B'), 'cross-workspace');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.artifactId).not.toBe(a.body.artifactId);
  });

  it('rejects an empty key instead of treating it as no key', async () => {
    const refused = await call(asPerson(ws), 'artifacts.create', note('Empty key'), '');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_input');
  });

  it('still accepts and dedupes the REST values it accepted before: spaces, non-ASCII, long', async () => {
    const keys = ['a key with spaces', 'nøkkel-é', 'k'.repeat(201)];
    for (const [i, key] of keys.entries()) {
      const name = `Legacy key ${i}`;
      const first = await call(asPerson(ws), 'artifacts.create', note(name), key);
      const replay = await call(asPerson(ws), 'artifacts.create', note(name), key);
      expect(first.status, key.slice(0, 12)).toBe(200);
      expect(replay.status, key.slice(0, 12)).toBe(200);
      expect(replay.body.artifactId, key.slice(0, 12)).toBe(first.body.artifactId);
    }
  });

  it('serialises two different principals under one key before the handler, so no external effect leaks', async () => {
    // The advisory lock is workspaces + key only, so the second caller waits. After the winner
    // commits, the caller-bound hash differs and the waiter answers the reused conflict *before*
    // its handler runs; otherwise its external side effects would survive the rollback.
    let runs = 0;
    const externalEffects: string[] = [];
    const slow = defineCommand({
      name: 'test.slowCrossPrincipal',
      title: 'Slow cross-principal write',
      description: 'Test-only command: two callers overlap under one key.',
      permission: null,
      effect: 'write',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        runs++;
        // Stands in for a segment refresh publishing membership events, or a ClickHouse message
        // event written by requestEmail: outside the transaction, a rollback cannot undo it.
        externalEffects.push(`${input.value}:${runs}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { value: input.value };
      },
    });
    const other = await t.signUp(`principal-other-${Date.now()}@example.com`);
    await t.srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [ws, other.id, 'owner']);
    const opts = { surface: 'rest' as const, idempotencyKey: 'concurrent-cross-principal' };
    const outcomes = await Promise.allSettled([
      t.srv.executor.execute(slow, { value: 'v' }, userPrincipal(owner.id, ws, 'owner'), opts),
      t.srv.executor.execute(slow, { value: 'v' }, userPrincipal(other.id, ws, 'owner'), opts),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'conflict', details: { reason: 'idempotency_key_reused' } } });
    expect(runs).toBe(1);
    expect(externalEffects).toEqual(['v:1']);
  });
});

// #926: a command that keeps its own input-level key (a direct send, a bulk enrollment) dedupes
// per workspace and key. The key is bound to an immutable request fingerprint (caller + the
// request as supplied, before any resolution), so another caller or changed variables answer 409,
// while a merged profile id or a re-rendered internal send still replays.
describe('an input-level idempotency key is bound to its caller and request (#926)', () => {
  let sender: User;
  let other: User;
  let emailTemplate = '';
  let smsTemplate = '';
  let pushTemplate = '';
  let journeyId = '';
  let otherJourneyId = '';
  let segmentId = '';
  let otherSegmentId = '';
  let mergedFrom = '';
  let mergedTo = '';
  let serverKey = '';
  const people = new Map<string, string>();

  const as = (u: User) => ({ cookie: u.cookie, origin: t.base, 'x-workspace-id': ws });
  const invoke = (u: User, command: string, body: unknown, key?: string): Promise<{ status: number; body: any }> =>
    fetch(`${t.base}/v1/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as(u), ...(key === undefined ? {} : { 'idempotency-key': key }) },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  const identify = (userId: string, traits: Record<string, unknown>) =>
    fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}` },
      body: JSON.stringify({ batch: [{ type: 'identify', userId, traits }] }),
    });

  const channels = [
    { channel: 'email' as const, command: 'messages.sendEmail', prefix: 'eml', template: () => emailTemplate },
    { channel: 'sms' as const, command: 'messages.sendSms', prefix: 'sms', template: () => smsTemplate },
    { channel: 'push' as const, command: 'messages.sendPush', prefix: 'psh', template: () => pushTemplate },
  ];

  const sendVia = (
    u: User,
    c: (typeof channels)[number],
    profileId: string,
    key: string,
    opts: { data?: unknown; template?: string } = {},
  ) =>
    invoke(u, c.command, {
      profileId,
      templateId: opts.template ?? c.template(),
      idempotencyKey: key,
      ...(opts.data === undefined ? {} : { data: opts.data }),
    });

  /** The same request through the gateway directly, for two-connection concurrency tests. */
  const sendDirect = (c: (typeof channels)[number], u: User, profileId: string, key: string) =>
    t.srv.db.withWorkspace(ws, (tx) => {
      const requestHash = sendRequestHash(c.channel, {
        caller: callerHash(userPrincipal(u.id, ws, 'marketer')),
        recipient: profileId,
        template: c.template(),
        data: null,
      });
      const req = { profileId, templateId: c.template(), idempotencyKey: key, requestHash };
      if (c.channel === 'email') return requestEmail(tx, ws, t.srv.keyProvider, t.srv.events, req);
      if (c.channel === 'sms') return requestSms(tx, ws, t.srv.keyProvider, t.srv.events, req);
      return requestPush(tx, ws, t.srv.keyProvider, t.srv.events, req);
    });

  const messageCount = async (key: string) =>
    (
      await t.srv.db.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND idempotency_key = $2',
        [ws, key],
      )
    ).rows[0]!.n;

  const enrollAs = (u: User, key: string, journey: string, segment: string, limit?: number) =>
    invoke(u, 'journeys.enrollSegment', {
      artifactId: journey,
      segmentId: segment,
      reason: 'Backfill',
      idempotencyKey: key,
      ...(limit ? { limit } : {}),
    });

  const makeJourney = async (name: string, event: string) => {
    const a = await t.api(owner, ws).call('artifacts.create', {
      type: 'journey',
      name,
      content: { purpose: 'marketing_email', nodes: [{ id: 'start', kind: 'trigger', label: 'Started', config: { event } }] },
    });
    await t.api(owner, ws).call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
    return a.artifactId;
  };
  const makeSegment = async (name: string) => {
    const a = await t.api(owner, ws).call('artifacts.create', {
      type: 'segment',
      name,
      content: { condition: { consent: 'marketing_email' } },
    });
    await t.api(owner, ws).call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
    return a.artifactId;
  };
  const publish = async (type: string, name: string, content: Record<string, unknown>) => {
    const a = await t.api(owner, ws).call('artifacts.create', { type, name, content } as never);
    await t.api(owner, ws).call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
    return a.artifactId as string;
  };
  const pushDevice = (userId: string) =>
    fetch(`${t.base}/v1/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}` },
      body: JSON.stringify({ userId, kind: 'fcm', token: `fcm-${userId}-0123456789` }),
    });
  const grant = (profileId: string, purpose: string) =>
    t.api(owner, ws).call('consent.record', { profileId, purpose, status: 'granted', source: 'form' });

  beforeAll(async () => {
    sender = await t.signUp(`key-sender-${Date.now()}@example.com`);
    other = await t.signUp(`key-other-${Date.now()}@example.com`);
    await t.srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $3)', [
      ws,
      sender.id,
      'marketer',
      other.id,
    ]);
    const api = t.api(owner, ws);
    serverKey = (await api.call('sources.create', { name: 'Keys backend', kind: 'server' })).key;

    emailTemplate = await publish('email_template', 'Issue', {
      purpose: 'marketing_email',
      subject: 'This week',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
    });
    smsTemplate = await publish('sms_template', 'SMS issue', {
      purpose: 'marketing_sms',
      body: 'Hi {{ profile.firstName | default: "there" }}, this week’s issue is out.',
      sampleData: { profile: { firstName: 'Ada' } },
    });
    pushTemplate = await publish('push_template', 'Push issue', {
      purpose: 'marketing_push',
      title: 'This week',
      body: 'The new issue is out.',
      url: 'https://example.com/issue',
      sampleData: { profile: { firstName: 'Ada' } },
    });

    await api.call('profiles.import', {
      label: 'Caller-bound keys',
      rows: ['one', 'two'].map((name) => ({
        email: `${name}@example.com`,
        consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
      })),
    });
    // Attach a user id, phone and push device to the same people, so all three channels can send.
    await identify('keys-one', { email: 'one@example.com', phone: '+4590000001' });
    await identify('keys-two', { email: 'two@example.com', phone: '+4590000002' });
    for (const name of ['one', 'two']) {
      const found = await eventually(
        () => api.call('profiles.find', { type: 'email', value: `${name}@example.com` }),
        (r) => !!r.profileId,
      );
      people.set(name, found.profileId!);
      // Let the import's consent write settle before another recompute for the same person.
      await eventually(
        () => api.call('profiles.get', { profileId: found.profileId! }),
        (p) => p.consentEffective.some((c) => c.purpose === 'marketing_email' && c.status === 'granted'),
      );
      await grant(found.profileId!, 'marketing_sms');
      await grant(found.profileId!, 'marketing_push');
      await pushDevice(`keys-${name}`);
    }
    for (const name of ['one', 'two']) {
      await eventually(
        () => api.call('profiles.get', { profileId: people.get(name)! }),
        (p) =>
          ['marketing_email', 'marketing_sms', 'marketing_push'].every((purpose) =>
            p.consentEffective.some((c) => c.purpose === purpose && c.status === 'granted'),
          ),
      );
    }

    // A person with two ids, then one id merged into the other: a send with the old id stores the
    // surviving profile, and an identical retry must still be recognised as the same request.
    await identify('merge-a', { email: 'merge-a@example.com', phone: '+4590000011' });
    await identify('merge-b', { email: 'merge-b@example.com', phone: '+4590000012' });
    mergedFrom = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: 'merge-a' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    mergedTo = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: 'merge-b' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    for (const purpose of ['marketing_email', 'marketing_sms', 'marketing_push']) await grant(mergedTo, purpose);
    await pushDevice('merge-b');
    await t.srv.db.admin.query(`INSERT INTO profile_merges (workspace_id, from_id, into_id, reason) VALUES ($1, $2, $3, 'test merge')`, [
      ws,
      mergedFrom,
      mergedTo,
    ]);
    await t.srv.db.admin.query('UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2', [ws, mergedFrom, mergedTo]);
    await t.srv.db.admin.query('DELETE FROM consent_state WHERE workspace_id = $1 AND profile_id = $2', [ws, mergedFrom]);

    journeyId = await makeJourney('Caller keys', 'Caller Keys Started');
    otherJourneyId = await makeJourney('Caller keys other', 'Caller Keys Other');
    segmentId = await makeSegment('Caller keys segment');
    otherSegmentId = await makeSegment('Caller keys other segment');
  }, 120_000);

  for (const c of channels)
    describe(c.channel, () => {
      it('replays the same caller with the same request', async () => {
        const key = `same-${c.channel}`;
        const first = await sendVia(sender, c, people.get('one')!, key);
        expect(first.status).toBe(200);
        const replay = await sendVia(sender, c, people.get('one')!, key);
        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({ messageId: first.body.messageId, duplicate: true });
      });

      it('refuses the same caller with different template variables', async () => {
        const key = `data-${c.channel}`;
        const first = await sendVia(sender, c, people.get('one')!, key, { data: { sku: 'A' } });
        expect(first.status).toBe(200);
        const changed = await sendVia(sender, c, people.get('one')!, key, { data: { sku: 'B' } });
        expect(changed.status).toBe(409);
        expect(changed.body.details?.reason).toBe('idempotency_key_reused');
        expect(JSON.stringify(changed.body)).not.toContain(first.body.messageId);
      });

      it('refuses the same caller with another recipient or template', async () => {
        const key = `recipient-${c.channel}`;
        const first = await sendVia(sender, c, people.get('one')!, key);
        expect(first.status).toBe(200);
        const recipient = await sendVia(sender, c, people.get('two')!, key);
        expect(recipient.status).toBe(409);
        expect(recipient.body.details?.reason).toBe('idempotency_key_reused');

        const key2 = `template-${c.channel}`;
        const firstTemplate = await sendVia(sender, c, people.get('one')!, key2);
        expect(firstTemplate.status).toBe(200);
        const template = await sendVia(sender, c, people.get('one')!, key2, { template: `${c.prefix}_${'f'.repeat(32)}` });
        expect(template.status).toBe(409);
        expect(template.body.details?.reason).toBe('idempotency_key_reused');
        expect(JSON.stringify(template.body)).not.toContain(firstTemplate.body.messageId);
      });

      it('refuses another caller without leaking the first message', async () => {
        const key = `caller-${c.channel}`;
        const first = await sendVia(sender, c, people.get('one')!, key);
        expect(first.status).toBe(200);
        const stolen = await sendVia(other, c, people.get('one')!, key);
        expect(stolen.status).toBe(409);
        expect(stolen.body.details?.reason).toBe('idempotency_key_reused');
        expect(JSON.stringify(stolen.body)).not.toContain(first.body.messageId);
      });

      it('replays a retry that still names the profile id merged into the recipient', async () => {
        const key = `merged-${c.channel}`;
        const first = await sendVia(sender, c, mergedFrom, key);
        expect(first.status).toBe(200);
        const stored = await t.srv.db.admin.query<{ profile_id: string }>(
          'SELECT profile_id FROM messages WHERE workspace_id = $1 AND idempotency_key = $2',
          [ws, key],
        );
        expect(stored.rows[0]?.profile_id).toBe(mergedTo);
        const retry = await sendVia(sender, c, mergedFrom, key);
        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ messageId: first.body.messageId, duplicate: true });
      });

      it('replays a concurrent identical request and refuses a concurrent other caller', async () => {
        const key = `concurrent-${c.channel}`;
        const results = await Promise.allSettled([
          sendDirect(c, sender, people.get('one')!, key),
          sendDirect(c, sender, people.get('one')!, key),
        ]);
        const ok = results
          .filter((r) => r.status === 'fulfilled')
          .map((r) => (r as PromiseFulfilledResult<{ messageId: string; duplicate: boolean }>).value);
        expect(ok).toHaveLength(2);
        expect(new Set(ok.map((r) => r.messageId)).size).toBe(1);
        expect(ok.map((r) => r.duplicate).sort()).toEqual([false, true]);
        expect(await messageCount(key)).toBe(1);

        const key2 = `concurrent-other-${c.channel}`;
        const different = await Promise.allSettled([
          sendDirect(c, sender, people.get('one')!, key2),
          sendDirect(c, other, people.get('one')!, key2),
        ]);
        expect(different.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = different.find((r) => r.status === 'rejected');
        expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'conflict', details: { reason: 'idempotency_key_reused' } } });
        expect(await messageCount(key2)).toBe(1);
      });
    });

  it('falls back to the stored columns for a message written before request_hash', async () => {
    const key = 'legacy-email';
    const messageId = `msg_${'a'.repeat(32)}`;
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, template_id, status)
       VALUES ($1, $2, $3, 'email', 'marketing_email', $4, $5, 'queued')`,
      [ws, messageId, key, people.get('one')!, emailTemplate],
    );
    const replay = await sendVia(sender, channels[0], people.get('one')!, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ messageId, duplicate: true });

    const changed = await sendVia(sender, channels[0], people.get('two')!, key);
    expect(changed.status).toBe(409);
    expect(changed.body.details?.reason).toBe('idempotency_key_reused');
  });

  it('replays an internal journey step and a broadcast redelivery from their stable identities', async () => {
    const han = people.get('one')!;
    const journeyKey = 'jrn:test:mail:1';
    const journeyHash = sendRequestHash('email', {
      caller: 'system:journey',
      recipient: han,
      template: emailTemplate,
      journey: journeyId,
      enrollment: 'prt_test',
      step: 'mail',
      sequence: 1,
    });
    const journeySend = (data: Record<string, unknown>) =>
      t.srv.db.withWorkspace(ws, (tx) =>
        requestEmail(tx, ws, t.srv.keyProvider, t.srv.events, {
          profileId: han,
          templateId: emailTemplate,
          idempotencyKey: journeyKey,
          journeyId,
          data,
          requestHash: journeyHash,
          agentId: null,
        }),
      );
    const j1 = await journeySend({ n: 1 });
    const j2 = await journeySend({ n: 2 });
    expect(j2).toMatchObject({ messageId: j1.messageId, duplicate: true });
    expect(await messageCount(journeyKey)).toBe(1);

    const broadcastKey = 'bct:test:one';
    const broadcastHash = sendRequestHash('email', {
      caller: 'system:broadcast',
      recipient: han,
      template: emailTemplate,
      broadcast: 'bct_test',
      variant: null,
    });
    const broadcastSend = (data: Record<string, unknown>) =>
      t.srv.db.withWorkspace(ws, (tx) =>
        requestEmail(tx, ws, t.srv.keyProvider, t.srv.events, {
          profileId: han,
          templateId: emailTemplate,
          idempotencyKey: broadcastKey,
          journeyId: 'bct_test',
          data,
          requestHash: broadcastHash,
          agentId: null,
        }),
      );
    const b1 = await broadcastSend({ n: 1 });
    const b2 = await broadcastSend({ n: 2 });
    expect(b2).toMatchObject({ messageId: b1.messageId, duplicate: true });
    expect(await messageCount(broadcastKey)).toBe(1);
  });

  it('replays an enrollment for the same caller and refuses another caller without leaking the job', async () => {
    const first = await enrollAs(sender, 'shared-enroll', journeyId, segmentId);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);

    const replay = await enrollAs(sender, 'shared-enroll', journeyId, segmentId);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ jobId: first.body.jobId, duplicate: true });

    const stolen = await enrollAs(other, 'shared-enroll', journeyId, segmentId);
    expect(stolen.status).toBe(409);
    expect(stolen.body.details?.reason).toBe('idempotency_key_reused');
    expect(JSON.stringify(stolen.body)).not.toContain(first.body.jobId);
  });

  it('refuses the same caller reusing an enrollment key for another journey, segment or limit', async () => {
    const first = await enrollAs(sender, 'enroll-other-input', journeyId, segmentId);
    expect(first.status).toBe(200);
    for (const [journey, segment, limit] of [
      [otherJourneyId, segmentId, undefined],
      [journeyId, otherSegmentId, undefined],
      [journeyId, segmentId, 1],
    ] as const) {
      const reused = await enrollAs(sender, 'enroll-other-input', journey, segment, limit ?? undefined);
      expect(reused.status).toBe(409);
      expect(reused.body.details?.reason).toBe('idempotency_key_reused');
      expect(JSON.stringify(reused.body)).not.toContain(first.body.jobId);
    }
  });

  it('runs a concurrent same-key enrollment once and refuses a concurrent other caller', async () => {
    const key = 'concurrent-enroll';
    const [a, b] = await Promise.all([enrollAs(sender, key, journeyId, segmentId), enrollAs(sender, key, journeyId, segmentId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toMatchObject({ jobId: a.body.jobId });
    const count = async (k: string) =>
      (
        await t.srv.db.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM enrollment_jobs WHERE workspace_id = $1 AND idempotency_key = $2',
          [ws, k],
        )
      ).rows[0]!.n;
    expect(await count(key)).toBe(1);

    const key2 = 'concurrent-enroll-other';
    const [x, y] = await Promise.all([enrollAs(sender, key2, journeyId, segmentId), enrollAs(other, key2, journeyId, segmentId)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const conflict = [x, y].find((r) => r.status === 409)!;
    expect(conflict.body.details?.reason).toBe('idempotency_key_reused');
    expect(await count(key2)).toBe(1);
  });
});
